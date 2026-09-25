import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  BundleReceiptSchema,
  MAX_PUBLIC_JSON_BYTES,
  PublicKeySchema,
  PUBLICATION_MAX_BYTES,
  PUBLICATION_MAX_FILES,
  canonicalJson,
  publicHashName,
} from '@fantasy/domain/spatial';
import {
  publishImmutableFile,
  readBoundedFile,
  sha256,
  syncDirectory,
  writeDurableFile,
} from '@fantasy/api/artifacts';

export { PUBLICATION_MAX_BYTES, PUBLICATION_MAX_FILES } from '@fantasy/domain/spatial';
export const PUBLICATION_CONTROL_KEY = 'control/league-usage.json';
export const PUBLICATION_CONTROL_BYTES = 65536;
export type PublicationFile = {
  key: string;
  bytes: number;
  checksum: string;
  data?: Buffer;
  source?: string;
};
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Reused for local export and remote collisions; a result hash includes its event/trajectory hashes. */
export function receiptIdentity(key: string, bytes: Buffer, results: Map<string, string>) {
  const receipt = BundleReceiptSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
  const { objectHash, ...body } = receipt;
  const definitive =
    receipt.result.outcome.kind === 'win' || receipt.result.outcome.kind === 'draw';
  if (
    key !== `objects/${publicHashName(objectHash)}/receipt.json` ||
    sha256(canonicalJson(body)) !== objectHash ||
    sha256(canonicalJson(receipt.result)) !== receipt.resultHash ||
    receipt.result.simulationHash !== receipt.simulationHash ||
    (definitive &&
      results.has(receipt.simulationHash) &&
      results.get(receipt.simulationHash) !== receipt.resultHash)
  )
    throw new Error('Existing simulation result conflict');
  if (definitive) results.set(receipt.simulationHash, receipt.resultHash);
  return receipt;
}

/** Public JSON is allowlisted by schemas; free text must not carry local diagnostics or credentials. */
export function assertPublicData(value: unknown): void {
  if (typeof value === 'string') {
    if (
      /(?:^|[\s="'(])(?:\/[^\s/]+[^\s]*|[a-z]:[\\/]|\\\\)|(?:^|[\\/])\.work(?:[\\/]|$)|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|secret|token|api[_-]?key|authorization)\s*[:=]|https?:\/\/[^\s/@]+:[^\s/@]+@/i.test(
        value,
      )
    )
      throw new Error('Private text is not publishable');
  } else if (Array.isArray(value)) value.forEach(assertPublicData);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (
        /^(?:env|environment|password|secret|token|apiKey|authorization|credentials|absolutePath)$/i.test(
          key,
        )
      )
        throw new Error('Private field is not publishable');
      assertPublicData(key);
      assertPublicData(item);
    }
  }
}

/** Check every ancestor, not just the final artifact entry. */
export async function publicationDirectory(path: string, create = false): Promise<void> {
  const full = resolve(path),
    parent = dirname(full);
  if (parent !== full) await publicationDirectory(parent, create);
  if (create)
    await mkdir(full).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  if (!(await lstat(full)).isDirectory())
    throw new Error('Publication directory must not be a symlink');
}
export async function optionalPublicationFile(path: string, limit: number) {
  try {
    await publicationDirectory(dirname(path));
    return await readBoundedFile(path, limit);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}
export function publicationJson(key: string, value: unknown): PublicationFile {
  assertPublicData(value);
  const data = Buffer.from(canonicalJson(value));
  if (data.length > MAX_PUBLIC_JSON_BYTES) throw new Error('Public JSON byte limit');
  return { key: PublicKeySchema.parse(key), bytes: data.length, checksum: sha256(data), data };
}
export async function publicationBytes(file: PublicationFile) {
  const data = file.data ?? (await readBoundedFile(file.source!, file.bytes));
  if (data.length !== file.bytes || sha256(data) !== file.checksum)
    throw new Error('Publication input changed after verification');
  return data;
}
export async function inspectPublicArtifact(file: PublicationFile, rawBytes?: number) {
  const data = await publicationBytes(file);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    rawBytes === undefined ? data : gunzipSync(data, { maxOutputLength: rawBytes }),
  );
  for (const line of file.key.endsWith('.ndjson.gz') ? text.trimEnd().split('\n') : [text])
    assertPublicData(JSON.parse(line) as unknown);
}

export async function publicationInventory(root: string, objectsOnly = false) {
  const files = new Map<string, number>();
  async function walk(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (objectsOnly && !prefix && entry.name !== 'objects') continue;
      if (!prefix && entry.name === '.publication-lock') continue;
      const key = prefix + entry.name,
        path = join(directory, entry.name);
      if (
        entry.isDirectory() &&
        /^(?:catalog|leagues|sets|objects|(?:sets|objects)\/[0-9a-f]{64})$/.test(key)
      )
        await walk(path, key + '/');
      else if (entry.isFile()) {
        files.set(PublicKeySchema.parse(key), (await lstat(path)).size);
        if (files.size > PUBLICATION_MAX_FILES) throw new Error('Publication file count limit');
      } else throw new Error('Unexpected publication entry or symlink');
    }
  }
  await walk(root, '');
  return files;
}

/** Preflight all collisions, privacy and capacity before writing even the first immutable file. */
export async function writePublication(
  root: string,
  files: PublicationFile[],
  current: PublicationFile,
  previous: Buffer | null,
  maxBytes: number,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PUBLICATION_MAX_BYTES)
    throw new Error('Invalid publication capacity');
  const stored = await publicationInventory(root);
  const incoming = new Map<string, string>();
  for (const file of files.filter((f) => f.key.endsWith('/receipt.json'))) {
    receiptIdentity(file.key, await publicationBytes(file), incoming);
  }
  for (const key of stored.keys())
    if (key.endsWith('/receipt.json')) {
      receiptIdentity(key, await readBoundedFile(join(root, key), 65536), incoming);
    }
  const additions: PublicationFile[] = [];
  const keys = new Set<string>();
  for (const file of files) {
    PublicKeySchema.parse(file.key);
    if (keys.has(file.key)) throw new Error('Duplicate publication key');
    keys.add(file.key);
    if (stored.has(file.key)) {
      const existing = await readBoundedFile(join(root, file.key), file.bytes);
      if (existing.length !== file.bytes || sha256(existing) !== file.checksum)
        throw new Error('Immutable publication collision');
    } else additions.push(file);
  }
  const unchanged = previous?.equals(current.data!) ?? false;
  const bytes =
    [...stored.values()].reduce((a, b) => a + b, 0) +
    additions.reduce((n, f) => n + f.bytes, 0) +
    (unchanged ? 0 : current.bytes);
  if (
    bytes > maxBytes ||
    stored.size + additions.length + (previous ? 0 : 1) > PUBLICATION_MAX_FILES
  )
    throw new Error('Publication capacity exceeded before writing');
  const assertGeneration = async () => {
    const now = await optionalPublicationFile(join(root, current.key), MAX_PUBLIC_JSON_BYTES);
    if (!(now === null ? previous === null : previous !== null && now.equals(previous)))
      throw new Error('Publication generation changed');
  };
  await assertGeneration();
  for (const file of additions) {
    await publicationDirectory(dirname(join(root, file.key)), true);
    await publishImmutableFile(join(root, file.key), await publicationBytes(file));
  }
  await assertGeneration();
  if (!previous?.equals(current.data!)) {
    await publicationDirectory(join(root, 'catalog'), true);
    // Mutable pointer replacement is last; staged pointer stays outside the public layout.
    const temporary = join(root, '.publication-lock', randomUUID());
    try {
      await writeDurableFile(temporary, await publicationBytes(current));
      await rename(temporary, join(root, current.key));
      await syncDirectory(join(root, 'catalog'));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return {
    addedFiles: additions.length,
    reusedFiles: files.length - additions.length,
    bytes: bytes - (unchanged ? 0 : (previous?.length ?? 0)),
  };
}
