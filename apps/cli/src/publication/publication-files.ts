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
  OperationError,
  operationInput,
  assertPublicData,
  publishImmutableFile,
  readBoundedFile,
  sha256,
  syncDirectory,
  writeDurableFile,
  measureAsync,
  PackArchive,
  replayRead,
} from '@fantasy/api/artifacts';
import { PublicationIo } from './publication-io.ts';
import { publicationPool } from './publication-pool.ts';

export { assertPublicData } from '@fantasy/api/artifacts';
export { PUBLICATION_MAX_BYTES, PUBLICATION_MAX_FILES } from '@fantasy/domain/spatial';
export const PUBLICATION_CONTROL_KEY = 'control/league-usage.json';
export const PUBLICATION_CONTROL_BYTES = 65536;
export type PublicationFile = {
  key: string;
  bytes: number;
  checksum: string;
  data?: Buffer;
  source?: string;
  rawBytes?: number;
  parts?: PublicationFile[];
  load?: () => Promise<Buffer>;
};
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Reused for local export and remote collisions; a result hash includes its event/trajectory hashes. */
export function receiptIdentity(key: string, bytes: Buffer, results: Map<string, string>) {
  const receipt = operationInput(
    () =>
      BundleReceiptSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      ),
    'DATA_INVALID',
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
    throw new OperationError('DATA_INVALID', 'Existing simulation result conflict');
  if (definitive) results.set(receipt.simulationHash, receipt.resultHash);
  return receipt;
}

const directoryChecks = new Map<string, Promise<void>>();
/** Share only overlapping checks; retain no successful or failed path validation in a cache. */
export function publicationDirectory(path: string, create = false): Promise<void> {
  const full = resolve(path),
    key = `${create ? 'create' : 'read'}:${full}`;
  const pending = directoryChecks.get(key);
  if (pending) return pending;
  const task = (async () => {
    const parent = dirname(full);
    if (parent !== full) await publicationDirectory(parent, create);
    if (create)
      await measureAsync('publication.directory.mkdir', () => mkdir(full)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
    const metadata = await measureAsync('publication.directory.lstat', () => lstat(full));
    if (!metadata.isDirectory())
      throw new OperationError('DATA_INVALID', 'Publication directory must not be a symlink');
  })();
  directoryChecks.set(key, task);
  const clear = () => {
    if (directoryChecks.get(key) === task) directoryChecks.delete(key);
  };
  void task.then(clear, clear);
  return task;
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
  if (data.length > MAX_PUBLIC_JSON_BYTES)
    throw new OperationError('BUDGET_EXCEEDED', 'Public JSON byte limit');
  return { key: PublicKeySchema.parse(key), bytes: data.length, checksum: sha256(data), data };
}
export async function publicationBytes(file: PublicationFile) {
  let data = file.data;
  if (!data && file.parts) {
    data = Buffer.alloc(file.bytes);
    let offset = 0;
    for (const part of file.parts) {
      const bytes = await publicationBytes(part);
      if (offset + bytes.length > data.length)
        throw new OperationError('DATA_INVALID', 'Pack assembly overflow');
      data.set(bytes, offset);
      offset += bytes.length;
    }
    if (offset !== data.length)
      throw new OperationError('DATA_INVALID', 'Pack assembly size mismatch');
  }
  data ??= file.load ? await file.load() : await readBoundedFile(file.source!, file.bytes);
  if (data.length !== file.bytes || sha256(data) !== file.checksum)
    throw new OperationError('DATA_INVALID', 'Publication input changed after verification');
  return data;
}
export async function inspectPublicArtifact(file: PublicationFile, rawBytes?: number) {
  const data = await publicationBytes(file);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    rawBytes === undefined ? data : gunzipSync(data, { maxOutputLength: rawBytes }),
  );
  for (const line of file.key.endsWith('.ndjson.gz') ? text.trimEnd().split('\n') : [text])
    assertPublicData(operationInput(() => JSON.parse(line) as unknown, 'DATA_INVALID'));
}

export async function publicationInventory(root: string, objectsOnly = false) {
  const files = new Map<string, number>();
  async function walk(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (objectsOnly && !prefix && !['objects', 'packs', 'pack-indexes'].includes(entry.name))
        continue;
      if (!prefix && entry.name === '.publication-lock') continue;
      const key = prefix + entry.name,
        path = join(directory, entry.name);
      if (
        entry.isDirectory() &&
        /^(?:catalog|leagues|sets|objects|packs|pack-indexes|(?:sets|objects)\/[0-9a-f]{64})$/.test(
          key,
        )
      )
        await walk(path, key + '/');
      else if (entry.isFile()) {
        files.set(PublicKeySchema.parse(key), (await lstat(path)).size);
        if (files.size > PUBLICATION_MAX_FILES)
          throw new OperationError('BUDGET_EXCEEDED', 'Publication file count limit');
      } else throw new OperationError('DATA_INVALID', 'Unexpected publication entry or symlink');
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
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PUBLICATION_MAX_BYTES)
    throw new OperationError('INPUT_INVALID', 'Invalid publication capacity');
  const stored = await publicationInventory(root);
  const incoming = new Map<string, string>();
  for (const file of files
    .flatMap((f) => f.parts ?? [f])
    .filter((f) => f.key.endsWith('/receipt.json'))) {
    receiptIdentity(file.key, await publicationBytes(file), incoming);
  }
  for (const key of stored.keys())
    if (key.endsWith('/receipt.json')) {
      receiptIdentity(key, await readBoundedFile(join(root, key), 65536), incoming);
    }
  const archive = new PackArchive(root);
  const packedObjects = new Set<string>();
  for (const key of stored.keys())
    if (key.startsWith('pack-indexes/')) {
      const { PackIndexSchema } = await import('@fantasy/domain/spatial');
      const index = PackIndexSchema.parse(
        JSON.parse(
          (await readBoundedFile(join(root, key), MAX_PUBLIC_JSON_BYTES)).toString('utf8'),
        ),
      );
      for (const entry of index.entries)
        if (entry.key.endsWith('/receipt.json'))
          packedObjects.add('sha256:' + entry.key.split('/')[1]!);
    }
  for (const object of packedObjects)
    receiptIdentity(
      `objects/${publicHashName(object)}/receipt.json`,
      await replayRead(await archive.location(object))('receipt.json', 65536),
      incoming,
    );
  const additions: PublicationFile[] = [];
  const keys = new Set<string>();
  for (const file of files) {
    PublicKeySchema.parse(file.key);
    if (keys.has(file.key)) throw new OperationError('DATA_INVALID', 'Duplicate publication key');
    keys.add(file.key);
    if (stored.has(file.key)) {
      const existing = await readBoundedFile(join(root, file.key), file.bytes);
      if (existing.length !== file.bytes || sha256(existing) !== file.checksum)
        throw new OperationError('PUBLICATION_CONFLICT', 'Immutable publication collision');
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
    throw new OperationError('BUDGET_EXCEEDED', 'Publication capacity exceeded before writing');
  const assertGeneration = async () => {
    const now = await optionalPublicationFile(join(root, current.key), MAX_PUBLIC_JSON_BYTES);
    if (!(now === null ? previous === null : previous !== null && now.equals(previous)))
      throw new OperationError('PUBLICATION_CONFLICT', 'Publication generation changed');
  };
  await assertGeneration();
  const width = files.some((file) => file.key.startsWith('packs/')) ? 2 : 4;
  const io = new PublicationIo(width, 64 * 1024 ** 2, signal);
  try {
    for (const packed of [true, false])
      await publicationPool(
        additions.filter((file) => file.key.startsWith('packs/') === packed),
        width,
        async (file) => {
          signal?.throwIfAborted();
          await publicationDirectory(dirname(join(root, file.key)), true);
          await io.run(
            file.bytes + Math.max(0, ...(file.parts ?? []).map((part) => part.bytes)),
            async () => publishImmutableFile(join(root, file.key), await publicationBytes(file)),
          );
        },
        'publication.write',
      );
  } finally {
    await io.close();
  }
  await assertGeneration();
  signal?.throwIfAborted();
  if (!previous?.equals(current.data!)) {
    await publicationDirectory(join(root, 'catalog'), true);
    // Mutable pointer replacement is last; staged pointer stays outside the public layout.
    const temporary = join(root, '.publication-lock', randomUUID());
    try {
      await writeDurableFile(temporary, await publicationBytes(current));
      signal?.throwIfAborted();
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
