import { afterEach, expect, it } from 'vite-plus/test';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipelineActionsFixture } from './test-support/league-actions.ts';
import { calibrationArchiveStream } from './league-calibration-upload.ts';
import { TransportReservation } from './league-transport-reservation.ts';
import { encodeSegmentV3, segmentV3Hash } from './league-segment-v3.ts';
import {
  sealedZipSegmentDiagnostic,
  sealedZipSegmentServiceDiagnostic,
  verifyDiagnosticSegmentZip,
  type LocalSegmentSink,
  type SealedSegmentServiceExecutor,
} from './league-sealed-zip-diagnostic.ts';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function serviceFixture() {
  const f = await fixture();
  const serviceExecutor: SealedSegmentServiceExecutor = async (path, receipt) => {
    expect(f.reservation.snapshot().reservedRefs).toBe(1);
    const info = await lstat(path);
    expect(info.mode & 0o222).toBe(0);
    const zip = await readFile(path);
    return {
      terminated: true,
      artifact: { id: 456, name: receipt.name, bytes: zip.length, digest: segmentV3Hash(zip) },
      zip,
    };
  };
  return {
    directory: f.directory,
    payload: f.payload,
    binding: f.binding,
    expected: f.expected,
    sourceSha: f.sourceSha,
    prefix: f.prefix,
    reservation: f.reservation,
    mode: 'service' as const,
    serviceExecutor,
  };
}
it('keeps a fakeable executor report unattested and disabled after strict ZIP roundtrip', async () => {
  const f = await serviceFixture();
  const result = await sealedZipSegmentServiceDiagnostic(f);
  expect(result.payload).toEqual(f.payload);
  expect(result.localOnly).toBe(false);
  expect('executionEnabled' in result && result.executionEnabled).toBe(false);
  expect('serviceCompatibility' in result && result.serviceCompatibility).toBe(
    'executor-reported-unattested',
  );
  expect(result.publicSdkUploadCompatibility).toBe('unmeasured');
});
it.each(['id', 'name', 'bytes', 'digest', 'zip', 'termination', 'unknown'])(
  'rejects executor %s failure without refund or compatibility elevation',
  async (fault) => {
    const f = await serviceFixture(),
      ordinary = f.serviceExecutor;
    f.serviceExecutor = async (path, receipt) => {
      const reply = await ordinary(path, receipt);
      if (fault === 'unknown') throw new Error('terminated child with unknown outcome');
      if (fault === 'id') reply.artifact.id = 0;
      if (fault === 'name') reply.artifact.name = 'foreign.zip';
      if (fault === 'bytes') reply.artifact.bytes++;
      if (fault === 'digest') reply.artifact.digest = 'sha256:' + 'd'.repeat(64);
      if (fault === 'zip') reply.zip[0] = reply.zip[0]! ^ 1;
      if (fault === 'termination') Object.assign(reply, { terminated: false });
      return reply;
    };
    await expect(sealedZipSegmentServiceDiagnostic(f)).rejects.toThrow();
    expect(f.reservation.snapshot().reservedRefs).toBe(1);
  },
);
it('rejects mixing local sink authority into a service diagnostic', async () => {
  const f = await serviceFixture();
  await expect(
    sealedZipSegmentServiceDiagnostic({ ...f, localOnly: true } as typeof f),
  ).rejects.toThrow();
  expect(f.reservation.snapshot().reservedRefs).toBe(0);
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'segment-sdk-'));
  directories.push(directory);
  const payload = Buffer.from('raw bytes spanning logical files');
  const hash = 'sha256:' + 'c'.repeat(64);
  const binding = {
    identity: pipelineActionsFixture().identity,
    runner: 0,
    index: 0,
    count: 1,
    totalBytes: payload.length,
    planHash: hash,
    inventoryHash: hash,
    streamHash: segmentV3Hash(payload),
    runtimeHash: hash,
  };
  const reservation = new TransportReservation(2, 40000000);
  const sink: LocalSegmentSink = async (stream, expected) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    return { ...expected, bytes: bytes.length, digest: segmentV3Hash(bytes), zip: bytes };
  };
  return {
    directory,
    payload,
    binding,
    expected: { ...binding, payloadHash: segmentV3Hash(payload) },
    sourceSha: binding.identity.source.sha,
    prefix: 'league-123-1',
    reservation,
    localOnly: true as const,
    sink,
  };
}
it('uses the actual SDK STORE encoder and raw reader with exact local bytes and no service requests', async () => {
  const f = await fixture();
  const result = await sealedZipSegmentDiagnostic(f);
  expect(result.bytes).toBe(f.payload.length + 256 + 136);
  expect(result.plaintextBytes).toBe(f.payload.length);
  expect(result.payload).toEqual(f.payload);
  expect(result.serviceRequests).toBe(0);
  expect(result.publicSdkUploadCompatibility).toBe('unmeasured');
  expect(f.reservation.snapshot().reservedBytes).toBe(result.bytes);
  expect(f.reservation.snapshot().reservedRefs).toBe(1);
});
it.each(['payload', 'attempt', 'source', 'prefix'])(
  'rejects foreign %s before debit',
  async (field) => {
    const f = await fixture();
    if (field === 'payload') f.payload[0] = f.payload[0]! ^ 1;
    if (field === 'attempt') f.expected.identity = { ...f.expected.identity, runAttempt: 2 };
    if (field === 'source') f.sourceSha = 'd'.repeat(40);
    if (field === 'prefix') f.prefix = 'league-123-2';
    await expect(sealedZipSegmentDiagnostic(f)).rejects.toThrow();
    expect(f.reservation.snapshot().reservedRefs).toBe(0);
  },
);
it('rejects the fixed diagnostic size ceiling and pre-cancellation without allocating a ref', async () => {
  const f = await fixture();
  await expect(
    sealedZipSegmentDiagnostic({ ...f, payload: Buffer.alloc(16 * 1024 ** 2 + 1) }),
  ).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(sealedZipSegmentDiagnostic({ ...f, signal: controller.signal })).rejects.toThrow();
  expect(f.reservation.snapshot().reservedRefs).toBe(0);
});
it.each(['unknown', 'foreign', 'abort', 'altered', 'received'])(
  'never refunds a %s sink outcome',
  async (fault) => {
    const f = await fixture(),
      controller = new AbortController();
    const ordinary = f.sink;
    f.sink = async (stream, expected) => {
      const reply = await ordinary(stream, expected);
      if (fault === 'unknown') throw new Error('uncertain local acknowledgement');
      if (fault === 'abort') controller.abort();
      if (fault === 'foreign') reply.sourceSha = 'd'.repeat(40);
      if (fault === 'altered') reply.digest = 'sha256:' + 'e'.repeat(64);
      if (fault === 'received') reply.zip[0] = reply.zip[0]! ^ 1;
      return reply;
    };
    await expect(sealedZipSegmentDiagnostic({ ...f, signal: controller.signal })).rejects.toThrow();
    expect(f.reservation.snapshot().reservedRefs).toBe(1);
    expect(f.reservation.snapshot().refundable).toBe(false);
  },
);
it('rejects ZIP tampering and extra entries using actual SDK archives, without a second ZIP encoder', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'segment.bin'), encodeSegmentV3(f.payload, f.binding));
  await writeFile(join(f.directory, 'extra.bin'), Buffer.from('extra'));
  for (const extra of [false, true]) {
    const stream = await calibrationArchiveStream(
      [join(f.directory, 'segment.bin'), ...(extra ? [join(f.directory, 'extra.bin')] : [])],
      f.directory,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const zip = Buffer.concat(chunks);
    const receipt = {
      name: 'league-123-1-segment-0-0-upload-0.zip',
      bytes: zip.length,
      digest: segmentV3Hash(zip),
      sourceSha: f.sourceSha,
      runtimeHash: f.binding.runtimeHash,
      allocationAttempt: 0 as const,
    };
    if (!extra) zip[0] = zip[0]! ^ 1;
    await expect(
      verifyDiagnosticSegmentZip(
        zip,
        receipt,
        f.expected,
        join(f.directory, extra ? 'extra-output' : 'tamper-output'),
      ),
    ).rejects.toThrow();
  }
  expect((await readFile(join(f.directory, 'extra.bin'))).toString()).toBe('extra');
});
it.each(['replace', 'symlink'])('rejects sealed ZIP path %s after streaming', async (fault) => {
  const f = await fixture(),
    ordinary = f.sink;
  f.sink = async (stream, expected) => {
    const reply = await ordinary(stream, expected);
    const owned = (await readdir(f.directory)).find((name) => name.startsWith('.sealed-segment-'))!;
    const path = join(f.directory, owned, expected.name);
    const bytes = await readFile(path);
    await chmod(path, 0o600);
    await rm(path);
    if (fault === 'replace') await writeFile(path, bytes, { mode: 0o400 });
    else {
      const other = join(f.directory, 'foreign.zip');
      await writeFile(other, bytes);
      await symlink(other, path);
    }
    return reply;
  };
  await expect(sealedZipSegmentDiagnostic(f)).rejects.toThrow();
  expect(f.reservation.snapshot().reservedRefs).toBe(1);
});
