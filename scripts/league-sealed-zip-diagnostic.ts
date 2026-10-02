import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { readBoundedFile } from '@fantasy/api/artifacts';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createRawFileUploadStream } from '../node_modules/@actions/artifact/lib/internal/upload/stream.js';
import { calibrationArchiveStream } from './league-calibration-upload.ts';
import { extractLeagueArchive } from './league-archive.ts';
import {
  decodeSegmentV3,
  encodeSegmentV3,
  segmentV3Hash,
  SEGMENT_V3_HEADER_BYTES,
  SEGMENT_V3_PAYLOAD_BYTES,
  type SegmentV3Binding,
  type SegmentV3Expected,
} from './league-segment-v3.ts';
import type { TransportReservation } from './league-transport-reservation.ts';

export type SealedSegmentReceipt = {
  name: string;
  bytes: number;
  digest: string;
  sourceSha: string;
  runtimeHash: string;
  allocationAttempt: 0 | 1;
};
type Receipt = SealedSegmentReceipt;
type Reply = Receipt & { zip: Buffer };
export type LocalSegmentSink = (stream: Readable, expected: Readonly<Receipt>) => Promise<Reply>;
/** Only the integration-owned fixed child executor may implement this boundary.
 * Its promise must settle (including rejection) only after child termination/drain.
 * No service trial is permitted until that executor/watchdog has been implemented and verified.
 */
export type SealedSegmentServiceExecutor = (
  path: string,
  expected: Readonly<Receipt>,
) => Promise<{
  terminated: true;
  artifact: { id: number; name: string; bytes: number; digest: string };
  zip: Buffer;
}>;
type SegmentOptions = {
  directory: string;
  payload: Buffer;
  binding: SegmentV3Binding;
  expected: SegmentV3Expected;
  sourceSha: string;
  prefix: string;
  reservation: TransportReservation;
  allocationAttempt?: 0 | 1;
};
type LocalOptions = SegmentOptions & {
  localOnly: true;
  sink: LocalSegmentSink;
  signal?: AbortSignal;
};
type ServiceOptions = SegmentOptions & {
  mode: 'service';
  serviceExecutor: SealedSegmentServiceExecutor;
  signal?: AbortSignal;
};
const overhead = 92 + 2 * Buffer.byteLength('segment.bin') + 22;
const zipLimit = SEGMENT_V3_HEADER_BYTES + SEGMENT_V3_PAYLOAD_BYTES + overhead;
async function bounded(stream: Readable, limit: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > limit) throw new Error('Diagnostic ZIP byte bound');
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    stream.destroy();
  }
}
async function witness(path: string, expected: Buffer) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== expected.length ||
    (info.mode & 0o222) !== 0 ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error('Diagnostic sealed ZIP ownership changed');
  const bytes = await readBoundedFile(path, expected.length);
  const next = await lstat(path);
  if (
    info.ino !== next.ino ||
    info.dev !== next.dev ||
    info.mtimeMs !== next.mtimeMs ||
    info.ctimeMs !== next.ctimeMs ||
    !bytes.equals(expected)
  )
    throw new Error('Diagnostic sealed ZIP replaced or bytes changed');
  return { ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}
/** Local authenticated archive check, sharing the production strict ZIP/segment decoders. */
export async function verifyDiagnosticSegmentZip(
  zip: Buffer,
  receipt: Readonly<Receipt>,
  expected: SegmentV3Expected,
  destination: string,
) {
  if (
    zip.length > zipLimit ||
    zip.length !== receipt.bytes ||
    segmentV3Hash(zip) !== receipt.digest ||
    receipt.sourceSha !== expected.identity.source.sha ||
    receipt.runtimeHash !== expected.runtimeHash ||
    ![0, 1].includes(receipt.allocationAttempt) ||
    receipt.name !==
      `league-${expected.identity.runId}-${expected.identity.runAttempt}-segment-${expected.runner}-${expected.index}-upload-${receipt.allocationAttempt}.zip`
  )
    throw new Error('Diagnostic received ZIP authentication mismatch');
  await extractLeagueArchive(
    zip,
    destination,
    (key) => key === 'segment.bin',
    false,
    'store-files-v1',
  );
  return decodeSegmentV3(await readFile(join(destination, 'segment.bin')), expected);
}
/** Off-only local diagnostic. No service client/token/default sink or publication authority.
 * Real SDK encoder/raw reader are exercised; public version-7 upload compatibility is unmeasured.
 * Runtime/main-CI authentication and complete producer validation remain caller gates.
 */
export async function sealedZipSegmentDiagnostic(options: LocalOptions) {
  return sealedSegment(options);
}
/** Explicit service authority, never disguised as a local sink. No SDK service calls here.
 * Runtime/bootstrap/admission and executor termination gates remain integration-owned.
 */
export async function sealedZipSegmentServiceDiagnostic(options: ServiceOptions) {
  if ('localOnly' in options || 'sink' in options)
    throw new Error('Service diagnostic cannot use local authority');
  return sealedSegment(options);
}
async function sealedSegment(options: LocalOptions | ServiceOptions) {
  const { binding, expected } = options;
  const local = 'localOnly' in options;
  const signal = options.signal;
  const allocationAttempt = options.allocationAttempt ?? 0;
  if (
    (local
      ? options.localOnly !== true || typeof options.sink !== 'function'
      : options.mode !== 'service' || typeof options.serviceExecutor !== 'function') ||
    !Buffer.isBuffer(options.payload) ||
    options.payload.length > 16 * 1024 ** 2 ||
    ![0, 1].includes(allocationAttempt) ||
    options.sourceSha !== binding.identity.source.sha ||
    options.prefix !== `league-${binding.identity.runId}-${binding.identity.runAttempt}`
  )
    throw new Error('Diagnostic source/prefix/local authority mismatch');
  signal?.throwIfAborted();
  const encoded = encodeSegmentV3(options.payload, binding);
  decodeSegmentV3(encoded, expected);
  const directory = await realpath(options.directory);
  const owned = await mkdtemp(join(directory, '.sealed-segment-'));
  let raw: Readable | undefined, sent: Readable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await chmod(owned, 0o700);
    const input = join(owned, 'segment.bin');
    await writeFile(input, encoded, { flag: 'wx', mode: 0o400 });
    const zip = await bounded(
      await calibrationArchiveStream([input], owned),
      encoded.length + overhead,
    );
    if (zip.length !== encoded.length + overhead || zip.length > zipLimit)
      throw new Error('Diagnostic SDK STORE framing mismatch');
    const name = `${options.prefix}-segment-${binding.runner}-${binding.index}-upload-${allocationAttempt}.zip`;
    const path = join(owned, name);
    await writeFile(path, zip, { flag: 'wx', mode: 0o400 });
    await chmod(path, 0o400);
    const before = await witness(path, zip);
    const sdkRoot = dirname(fileURLToPath(import.meta.resolve('@actions/artifact')));
    const manifest = JSON.parse(await readFile(join(sdkRoot, '../package.json'), 'utf8')) as {
      version?: unknown;
    };
    if (manifest.version !== '6.2.1') throw new Error('Diagnostic SDK version mismatch');
    const receipt = Object.freeze({
      name,
      bytes: zip.length,
      digest: segmentV3Hash(zip),
      sourceSha: options.sourceSha,
      runtimeHash: binding.runtimeHash,
      allocationAttempt,
    });
    if (!local) {
      // The executor owns the whole-child watchdog; never race it and delete a still-used staging file.
      options.reservation.reserve(name, zip.length);
      const result = await options.serviceExecutor(path, receipt);
      signal?.throwIfAborted();
      const after = await witness(path, zip);
      if (
        result.terminated !== true ||
        !Number.isSafeInteger(result.artifact.id) ||
        result.artifact.id < 1 ||
        result.artifact.name !== receipt.name ||
        result.artifact.bytes !== receipt.bytes ||
        result.artifact.digest !== receipt.digest ||
        JSON.stringify(before) !== JSON.stringify(after) ||
        !Buffer.isBuffer(result.zip) ||
        result.zip.length !== receipt.bytes ||
        segmentV3Hash(result.zip) !== receipt.digest
      )
        throw new Error('Diagnostic service termination/artifact/download mismatch');
      const received = Buffer.from(result.zip);
      await writeFile(join(owned, 'received.zip'), received, { flag: 'wx', mode: 0o400 });
      const payload = await verifyDiagnosticSegmentZip(
        received,
        receipt,
        expected,
        join(owned, 'extracted'),
      );
      if (!payload.equals(options.payload))
        throw new Error('Diagnostic service payload roundtrip mismatch');
      return {
        ...receipt,
        payload,
        mode: 'service-diagnostic' as const,
        localOnly: false as const,
        artifactId: result.artifact.id,
        serviceRequests: 'unmeasured' as const,
        allocationAttempts: 1,
        encodedSegmentBytes: encoded.length,
        plaintextBytes: payload.length,
        executionEnabled: false as const,
        serviceCompatibility: 'executor-reported-unattested' as const,
        publicSdkUploadCompatibility: 'unmeasured' as const,
      };
    }
    const hash = createHash('sha256');
    let bytes = 0,
      complete = false;
    signal?.throwIfAborted();
    // Synchronous allocation debit immediately before starting the SDK raw reader/sink.
    options.reservation.reserve(name, zip.length);
    raw = await createRawFileUploadStream(path);
    const source = raw;
    sent = Readable.from(
      (async function* () {
        for await (const chunk of source) {
          signal?.throwIfAborted();
          bytes += Buffer.byteLength(chunk);
          if (bytes > receipt.bytes) throw new Error('Diagnostic raw upload byte bound');
          hash.update(chunk);
          yield chunk;
        }
        complete = true;
      })(),
    );
    const stream = sent;
    const stop = () => {
      stream.destroy(new Error('Diagnostic cancelled'));
      source.destroy();
    };
    signal?.addEventListener('abort', stop, { once: true });
    let reply: Reply;
    try {
      reply = await Promise.race([
        options.sink(stream, receipt),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            stop();
            reject(new Error('Diagnostic local sink timeout'));
          }, 5000);
        }),
        new Promise<never>((_, reject) => {
          stream.once('error', reject);
        }),
      ]);
    } finally {
      signal?.removeEventListener('abort', stop);
      if (timer) clearTimeout(timer);
    }
    signal?.throwIfAborted();
    const after = await witness(path, zip);
    if (
      !complete ||
      bytes !== receipt.bytes ||
      'sha256:' + hash.digest('hex') !== receipt.digest ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      Object.keys(receipt).some(
        (key) => reply[key as keyof Receipt] !== receipt[key as keyof Receipt],
      )
    )
      throw new Error('Diagnostic raw upload/acknowledgement mismatch');
    if (
      !Buffer.isBuffer(reply.zip) ||
      reply.zip.length !== receipt.bytes ||
      segmentV3Hash(reply.zip) !== receipt.digest
    )
      throw new Error('Diagnostic actual received ZIP mismatch');
    const received = Buffer.from(reply.zip);
    await writeFile(join(owned, 'received.zip'), received, { flag: 'wx', mode: 0o400 });
    const extracted = join(owned, 'extracted');
    const decoded = await verifyDiagnosticSegmentZip(received, receipt, expected, extracted);
    if (!decoded.equals(options.payload)) throw new Error('Diagnostic payload roundtrip mismatch');
    return {
      ...receipt,
      payload: decoded,
      localOnly: true as const,
      serviceRequests: 0,
      allocationAttempts: 1,
      encodedSegmentBytes: encoded.length,
      plaintextBytes: decoded.length,
      publicSdkUploadCompatibility: 'unmeasured' as const,
    };
  } finally {
    sent?.destroy();
    raw?.destroy();
    if (raw) await finished(raw).catch(() => undefined);
    if (sent) await finished(sent).catch(() => undefined);
    await rm(owned, { recursive: true, force: true });
  }
}
