import type { BigIntStats } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import {
  canonicalJson,
  HashSchema,
  LeaguePipelineIdentitySchema,
  LeagueProducerProofSchema,
} from '@fantasy/domain/spatial';
import { executionSource } from '@fantasy/api/tooling';
import { readBoundedFile, sha256 } from '@fantasy/api/artifacts';
import { publicationDirectory } from '../apps/cli/src/publication/publication-files.ts';
import { calibrationArchiveStream } from './league-calibration-upload.ts';
import { extractLeagueArchive, archiveHash } from './league-archive.ts';
import { inspectTransportZipBound } from './league-transport-zip-bound.ts';
import {
  inspectOffModeTransportV2,
  OffModeTransportV2Schema,
  TransportV2Error,
} from './league-transport-v2.ts';

const requestSchema = z.strictObject({
  identity: LeaguePipelineIdentitySchema,
  planId: HashSchema,
  inputHash: HashSchema,
  proofHash: HashSchema,
  runner: z.number().int().min(0).max(3),
  partition: z.number().int().min(0).max(63),
  compressionLevel: z.literal(0),
});
type Request = z.infer<typeof requestSchema>;
// Reviewed format-defining files from the frozen SDK dependency graph, not a
// caller-supplied version label. This is NOT authentication of the entire runtime.
const formatDigest = 'sha256:fdc1b243019d55330b4246db5498d2fb0379903a9755684a17261be6f472553d';
async function encoderProvenance() {
  const sdk = dirname(fileURLToPath(import.meta.resolve('@actions/artifact')));
  const require = createRequire(join(sdk, '../package.json'));
  const locations = [
    ['sdk/zip.js', join(sdk, 'internal/upload/zip.js')],
    ['sdk/spec.js', join(sdk, 'internal/upload/upload-zip-specification.js')],
    ['sdk/stream.js', join(sdk, 'internal/upload/stream.js')],
  ];
  for (const [name, paths] of [
    ['archiver', ['lib/core.js', 'lib/plugins/zip.js']],
    ['zip-stream', ['index.js']],
    [
      'compress-commons',
      [
        'lib/archivers/zip/zip-archive-output-stream.js',
        'lib/archivers/zip/zip-archive-entry.js',
        'lib/archivers/zip/general-purpose-bit.js',
        'lib/archivers/zip/util.js',
        'lib/archivers/zip/constants.js',
      ],
    ],
  ] as const) {
    const root = dirname(require.resolve(name + '/package.json'));
    for (const path of paths) locations.push([name + '/' + path, join(root, path)]);
  }
  const rows = [];
  for (const [key, path] of locations)
    rows.push({ key, hash: sha256(await readBoundedFile(path!, 2 * 1024 ** 2)) });
  const digest = sha256(JSON.stringify(rows));
  if (digest !== formatDigest) throw new Error('Transport encoder format provenance mismatch');
  return {
    formatDigest: digest,
    lockHash: sha256(
      await readBoundedFile(
        fileURLToPath(new URL('../pnpm-lock.yaml', import.meta.url)),
        4_000_000,
      ),
    ),
  };
}

type Entry = { bytes: number; checksum: string; metadata: string };
async function inventory(root: string, signal?: AbortSignal) {
  const files = new Map<string, Entry>();
  const directories = new Map<string, string>();
  let rawBytes = 0,
    visits = 0,
    maxNameBytes = 0;
  const metadata = (info: BigIntStats) =>
    [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  async function walk(path: string, prefix: string, depth: number) {
    signal?.throwIfAborted();
    if (depth > 16 || ++visits > 8192) throw new Error('Transport inventory depth/count bound');
    await publicationDirectory(path);
    const before = await lstat(path, { bigint: true });
    if (!before.isDirectory()) throw new Error('Transport directory type mismatch');
    directories.set(prefix, metadata(before));
    for (const item of await readdir(path, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const key = prefix + item.name,
        full = join(path, item.name);
      if (
        !/^[A-Za-z0-9_.@/-]+$/.test(key) ||
        key.split('/').some((part) => part === '.' || part === '..')
      )
        throw new Error('Transport filename mismatch');
      if (item.isDirectory()) await walk(full, key + '/', depth + 1);
      else {
        const beforeFile = await lstat(full, { bigint: true });
        if (!item.isFile() || !beforeFile.isFile() || ++visits > 8192 || files.size >= 4096)
          throw new Error('Transport file type/count mismatch');
        maxNameBytes = Math.max(maxNameBytes, Buffer.byteLength(key));
        rawBytes += Number(beforeFile.size);
        if (maxNameBytes > 256 || !Number.isSafeInteger(rawBytes) || rawBytes > 48 * 1024 ** 2)
          throw new Error('Transport raw/name bound');
        const checksum = sha256(await readBoundedFile(full, Number(beforeFile.size)));
        const after = await lstat(full, { bigint: true });
        if (metadata(beforeFile) !== metadata(after))
          throw new Error('Transport file changed while sealing');
        files.set(key, { bytes: Number(beforeFile.size), checksum, metadata: metadata(after) });
      }
    }
    if (metadata(before) !== metadata(await lstat(path, { bigint: true })))
      throw new Error('Transport directory changed while sealing');
  }
  await walk(root, '', 0);
  return { files, directories, rawBytes, maxNameBytes };
}
type Inventory = Awaited<ReturnType<typeof inventory>>;
function sameInventory(first: Inventory, next: Inventory) {
  return (
    canonicalJson([...first.files]) === canonicalJson([...next.files]) &&
    canonicalJson([...first.directories]) === canonicalJson([...next.directories])
  );
}
/** Private witness of measured postcompute ZIP bytes. It is never a precompute proof. */
export type TransportSeal = Readonly<{
  kind: 'postcompute-sealed-zip';
  digest: string;
  bytes: number;
}>;
const seals = new WeakMap<
  TransportSeal,
  { request: Request; data: Buffer; provenance: Awaited<ReturnType<typeof encoderProvenance>> }
>();
let reserved: 'sealing' | TransportSeal | undefined;
function authenticSeal(value: TransportSeal) {
  const seal = seals.get(value);
  if (!seal) throw new Error('Missing process-local transport seal');
  return seal;
}

async function encodeSnapshot(
  root: string,
  expected: Map<string, { bytes: number; checksum: string }>,
  limit: number,
  rawBytes: number,
  signal?: AbortSignal,
) {
  const temporary = await mkdtemp(join(tmpdir(), 'fantasy-transport-seal-'));
  try {
    const snapshot = join(temporary, 'source');
    const files = [];
    for (const [key, file] of expected) {
      signal?.throwIfAborted();
      const data = await readBoundedFile(join(root, key), file.bytes);
      if (sha256(data) !== file.checksum) throw new Error('Transport snapshot changed');
      const path = join(snapshot, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data, { flag: 'wx', mode: 0o400 });
      files.push(path);
    }
    signal?.throwIfAborted();
    const stream = await calibrationArchiveStream(files, snapshot);
    const chunks: Buffer[] = [];
    let encodedBytes = 0,
      chunkCount = 0;
    try {
      // Once encoding starts, drain this private, finite snapshot on cancellation.
      // Do not abandon an SDK producer which only exposes its output stream.
      for await (const chunk of stream) {
        encodedBytes += Buffer.byteLength(chunk);
        if (encodedBytes > limit || ++chunkCount > 16384)
          throw new Error('Transport encoded/chunk bound');
        if (!signal?.aborted) chunks.push(Buffer.from(chunk));
      }
    } finally {
      stream.destroy();
    }
    signal?.throwIfAborted();
    const data = Buffer.concat(chunks, encodedBytes);
    const decoded = join(temporary, 'decoded');
    const extracted = await extractLeagueArchive(
      data,
      decoded,
      (key) => expected.has(key),
      false,
      'store-files-v1',
    );
    if (extracted.files !== expected.size || extracted.bytes !== rawBytes)
      throw new Error('Transport ZIP coverage mismatch');
    for (const [key, file] of expected) {
      signal?.throwIfAborted();
      if (sha256(await readBoundedFile(join(decoded, key), file.bytes)) !== file.checksum)
        throw new Error('Transport ZIP contents changed');
    }
    return data;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** No service allocation. All control/public files and the exact SDK ZIP are checked. */
async function buildTransportSeal(
  rootPath: string,
  requestValue: unknown,
  signal?: AbortSignal,
): Promise<TransportSeal> {
  signal?.throwIfAborted();
  const request = requestSchema.parse(requestValue);
  const source = executionSource();
  if (canonicalJson(source) !== canonicalJson(request.identity.source))
    throw new Error('Transport source mismatch');
  const provenance = await encoderProvenance();
  const root = resolve(rootPath);
  const before = await inventory(root, signal);
  const proofBytes = await readBoundedFile(join(root, 'proof.json'), 16 * 1024 ** 2);
  const proof = LeagueProducerProofSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(proofBytes)),
  );
  if (
    sha256(proofBytes) !== request.proofHash ||
    proof.planId !== request.planId ||
    proof.inputHash !== request.inputHash ||
    canonicalJson(proof.identity) !== canonicalJson(request.identity) ||
    proof.runner !== request.runner ||
    proof.partition !== request.partition
  )
    throw new Error('Transport producer binding mismatch');
  const expected = new Map(
    proof.files.map((file) => [
      'public/' + file.key,
      { bytes: file.bytes, checksum: file.checksum },
    ]),
  );
  expected.set('proof.json', { bytes: proofBytes.length, checksum: request.proofHash });
  const result = await readBoundedFile(join(root, 'result.json'), 16 * 1024 ** 2);
  expected.set('result.json', { bytes: result.length, checksum: proof.resultHash });
  const allowedDirectories = new Set(['']);
  for (const key of expected.keys()) {
    const parts = key.split('/');
    for (let length = 1; length < parts.length; length++)
      allowedDirectories.add(parts.slice(0, length).join('/') + '/');
  }
  if (
    expected.size !== proof.files.length + 2 ||
    expected.size !== before.files.size ||
    allowedDirectories.size !== before.directories.size ||
    [...before.directories.keys()].some((key) => !allowedDirectories.has(key)) ||
    proofBytes.length + result.length > 16 * 1024 ** 2 ||
    [...expected].some(
      ([key, file]) =>
        before.files.get(key)?.bytes !== file.bytes ||
        before.files.get(key)?.checksum !== file.checksum,
    )
  )
    throw new Error('Transport exact inventory/checksum mismatch');
  const report = inspectTransportZipBound({
    encoder: 'actions-artifact-6.2.1-store-files-v1',
    rawBytesUpper: before.rawBytes,
    fileCountUpper: before.files.size,
    maxNameBytesUpper: before.maxNameBytes,
  });
  const data = await encodeSnapshot(
    root,
    expected,
    report.encodedBytesUpper,
    before.rawBytes,
    signal,
  );
  if (
    !sameInventory(before, await inventory(root, signal)) ||
    canonicalJson(provenance) !== canonicalJson(await encoderProvenance()) ||
    canonicalJson(source) !== canonicalJson(executionSource())
  )
    throw new Error('Transport seal/source changed');
  signal?.throwIfAborted();
  const witness = Object.freeze({
    kind: 'postcompute-sealed-zip' as const,
    digest: archiveHash(data),
    bytes: data.length,
  });
  seals.set(witness, { request, data, provenance });
  return witness;
}

/** At most one active or retained seal. No service lease is allocated or refunded. */
export async function sealOffModeTransport(
  rootPath: string,
  requestValue: unknown,
  signal?: AbortSignal,
) {
  if (reserved) throw new Error('Transport seal slot reserved');
  reserved = 'sealing';
  try {
    const witness = await buildTransportSeal(rootPath, requestValue, signal);
    if (signal?.aborted) {
      seals.delete(witness);
      signal.throwIfAborted();
    }
    reserved = witness;
    return witness;
  } catch (error) {
    reserved = undefined;
    throw error;
  }
}

/** Releases only process-local bytes; never resets attempts or communication budgets. */
export function closeOffModeTransportSeal(value: TransportSeal) {
  authenticSeal(value);
  if (reserved !== value) throw new Error('Transport seal ownership mismatch');
  seals.delete(value);
  reserved = undefined;
}

/** Copies the same validated ZIP, never re-encodes mutable source paths. Execution remains off. */
export function readOffModeTransportSeal(value: TransportSeal, expected: unknown) {
  const seal = authenticSeal(value);
  if (
    canonicalJson(requestSchema.parse(expected)) !== canonicalJson(seal.request) ||
    canonicalJson(executionSource()) !== canonicalJson(seal.request.identity.source)
  )
    throw new Error('Transport seal binding/source mismatch');
  return {
    mode: 'off' as const,
    executionEnabled: false as const,
    stage: 'postcompute-measured' as const,
    provenance: { ...seal.provenance },
    remainingGates: [
      'authenticated-input-and-producer-execution',
      'authenticated-encoder-runtime-closure',
      'authenticated-precompute-output-bound',
      'metadata-transfer-retry-and-storage-budget',
      'same-source-whole-critical-path',
    ] as const,
    zip: Buffer.from(seal.data),
  };
}

/** Rejects measured or serialized evidence as a deterministic precompute bound. */
export function requirePrecomputeTransportOutput(modelValue: unknown, value: TransportSeal): never {
  const seal = authenticSeal(value);
  inspectOffModeTransportV2(modelValue);
  const model = OffModeTransportV2Schema.parse(modelValue);
  if (
    model.sourceSha !== seal.request.identity.source.sha ||
    model.planId !== seal.request.planId ||
    !model.inputs.some(
      (input) =>
        input.partition === seal.request.partition &&
        input.inputHash === seal.request.inputHash &&
        input.output.kind === 'deterministic-next-fit-v1' &&
        input.output.proofHash === seal.request.proofHash,
    ) ||
    !model.assignments.some(
      (assignment) =>
        assignment.runner === seal.request.runner &&
        assignment.partitions.includes(seal.request.partition),
    )
  )
    throw new TransportV2Error('OUTPUT_PROOF_BINDING', 'Precompute model/seal binding mismatch');
  throw new TransportV2Error(
    'OUTPUT_UNKNOWN',
    'Postcompute ZIP cannot authenticate a future output upper bound',
  );
}
