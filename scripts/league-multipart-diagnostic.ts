import { dirname, join, resolve } from 'node:path';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  LeagueCloudInputSchema,
  LeagueProducerProofSchema,
} from '@fantasy/domain/spatial';
import { executionSource } from '@fantasy/api/tooling';
import { readBoundedFile, sha256 } from '@fantasy/api/artifacts';
import { publicationInventory } from '../apps/cli/src/publication/publication-files.ts';
import { packedProducerDescriptor } from '../apps/cli/src/league/league-producer-transport.ts';
import {
  validateLeagueProducerDiagnostic,
  type PipelineIdentity,
} from '../apps/cli/src/league/league-producer.ts';
import { verifyLeagueRuntime } from './league-runtime.ts';
import { assignLeagueRunners } from '../apps/cli/src/league/league-assignment.ts';
import { TransportReservation } from './league-transport-reservation.ts';
import {
  sealedZipSegmentDiagnostic,
  type LocalSegmentSink,
} from './league-sealed-zip-diagnostic.ts';

// A tighter local-only diagnostic envelope, not an execution/cost/capacity admission.
export const MULTIPART_DIAGNOSTIC_BYTES = 16 * 1024 ** 2;
export type MultipartDiagnosticPartition = { root: string; input: unknown };

/** Authenticate sealed producer inventory without repeating its already completed full verifier. */
export async function multipartDiagnosticInventory(
  partitions: readonly MultipartDiagnosticPartition[],
  identity: PipelineIdentity,
  runner: number,
  runners: number,
) {
  if (
    partitions.length < 1 ||
    partitions.length > 16 ||
    runner < 0 ||
    runner > 3 ||
    !Number.isInteger(runner)
  )
    throw new Error('Multipart diagnostic partition/runner bound');
  if (!Number.isInteger(runners) || runners < 1 || runners > 4 || runner >= runners)
    throw new Error('Multipart diagnostic runner width bound');
  const inputs = partitions.map((value) => LeagueCloudInputSchema.parse(value.input));
  const indices = inputs.map((input) => input.partition.index);
  if (new Set(indices).size !== indices.length) throw new Error('Multipart duplicate partition');
  const plan = inputs[0]!.plan;
  if (inputs.some((input) => canonicalJson(input.plan) !== canonicalJson(plan)))
    throw new Error('Multipart mixed prepared plans');
  const assigned = assignLeagueRunners(plan, runners)[runner]?.partitions;
  if (
    !assigned ||
    canonicalJson([...indices].sort((a, b) => a - b)) !==
      canonicalJson([...assigned].sort((a, b) => a - b))
  )
    throw new Error('Multipart missing/excess assigned partition');
  const descriptors = [],
    files: { path: string; source: string; bytes: number; checksum: string }[] = [];
  let rawBytes = 0;
  for (const value of partitions) {
    const input = LeagueCloudInputSchema.parse(value.input);
    const proof = LeagueProducerProofSchema.parse(
      JSON.parse(
        (
          await readBoundedFile(join(value.root, 'proof.json'), MULTIPART_DIAGNOSTIC_BYTES)
        ).toString('utf8'),
      ),
    );
    if (
      canonicalJson(proof.identity) !== canonicalJson(identity) ||
      proof.runner !== runner ||
      proof.partition !== input.partition.index ||
      proof.inputHash !== sha256(canonicalJson(input)) ||
      proof.partitionId !== input.partition.id ||
      proof.planId !== input.plan.id ||
      canonicalJson(input.plan.source) !== canonicalJson(identity.source) ||
      input.reservation.executionId !== `league-${identity.runId}-${identity.runAttempt}`
    )
      throw new Error('Multipart diagnostic input/proof identity mismatch');
    const names = (await readdir(value.root)).sort();
    if (canonicalJson(names) !== canonicalJson(['proof.json', 'public', 'result.json']))
      throw new Error('Multipart unexpected producer control entry');
    const actual = await publicationInventory(join(value.root, 'public'));
    if (
      actual.size !== proof.files.length ||
      proof.files.some((file) => actual.get(file.key) !== file.bytes)
    )
      throw new Error('Multipart producer inventory coverage mismatch');
    if (proof.files.reduce((n, file) => n + file.bytes, rawBytes) > MULTIPART_DIAGNOSTIC_BYTES)
      throw new Error('Multipart local diagnostic byte bound');
    const descriptor = await packedProducerDescriptor(value.root, proof);
    rawBytes += descriptor.files.reduce((n, file) => n + file.bytes, 0);
    if (rawBytes > MULTIPART_DIAGNOSTIC_BYTES)
      throw new Error('Multipart local diagnostic byte bound');
    descriptors.push({ ...descriptor, inputHash: proof.inputHash });
    for (const file of descriptor.files)
      files.push({
        ...file,
        source: join(value.root, file.path.slice(`partitions/${proof.partition}/`.length)),
      });
  }
  if (
    new Set(descriptors.map((value) => value.partition)).size !== partitions.length ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    new Set(descriptors.map((value) => value.inputHash)).size !== partitions.length
  )
    throw new Error('Multipart duplicate partition/file/input');
  descriptors.sort((a, b) => a.partition - b.partition);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = {
    schemaVersion: 3 as const,
    identity,
    runner,
    partitions: descriptors,
    files: files.map(({ source: _source, ...file }) => file),
  };
  return { manifest, files, rawBytes, inventoryHash: sha256(canonicalJson(manifest)) };
}

/** Complete unique ordered inventory restoration, then the existing producer content checks.
 * No service artifact witness or formal-finalizer-compatible producer is returned.
 */
async function receiveMultipartDiagnostic(
  destination: string,
  inventory: Awaited<ReturnType<typeof multipartDiagnosticInventory>>,
  bytes: Buffer,
  partitions: readonly MultipartDiagnosticPartition[],
) {
  if (bytes.length !== inventory.rawBytes || bytes.length > MULTIPART_DIAGNOSTIC_BYTES)
    throw new Error('Multipart missing/excess stream bytes');
  let offset = 0;
  for (const file of inventory.files) {
    const data = bytes.subarray(offset, offset + file.bytes);
    offset += file.bytes;
    if (sha256(data) !== file.checksum)
      throw new Error('Multipart restored file checksum mismatch');
    const path = join(destination, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { flag: 'wx', mode: 0o400 });
  }
  const { identity, runner } = inventory.manifest;
  const verified = [];
  for (const descriptor of inventory.manifest.partitions) {
    const input = partitions.find(
      (value) => LeagueCloudInputSchema.parse(value.input).partition.index === descriptor.partition,
    )?.input;
    if (!input || sha256(canonicalJson(input)) !== descriptor.inputHash)
      throw new Error('Multipart receiver missing/changed input');
    verified.push(
      await validateLeagueProducerDiagnostic(
        join(destination, 'partitions', String(descriptor.partition)),
        input,
        identity,
        runner,
      ),
    );
  }
  return verified;
}

/** Uses only the actual executing checkout's local dependency snapshot. Trusted main CI remains required. */
export async function multipartDiagnosticRuntime(distribution: string, identity: PipelineIdentity) {
  if (canonicalJson(executionSource()) !== canonicalJson(identity.source))
    throw new Error('Multipart executing source mismatch');
  const checkout = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const runtime = await verifyLeagueRuntime(checkout, distribution, identity.source.sha);
  return {
    runtime,
    runtimeHash: sha256(await readBoundedFile(join(distribution, 'runtime.json'), 16_000_000)),
  };
}

export function multipartDiagnosticReservation() {
  // Inside the unchanged 2-runner calibration compute allocation; one retry is pre-reserved.
  return new TransportReservation(2, 40 * 1024 ** 2);
}

/** Local-only vertical diagnostic. Producer sealing precedes this receiver's content checks.
 * It grants no service identity, official publication, precompute, cost or capacity authority.
 */
export async function roundtripMultipartDiagnostic(options: {
  partitions: readonly MultipartDiagnosticPartition[];
  identity: PipelineIdentity;
  runner: number;
  runners: number;
  distribution: string;
  sink: LocalSegmentSink;
  reservation: TransportReservation;
  signal?: AbortSignal;
  allocationAttempt?: 0 | 1;
}) {
  const { identity, runner, distribution, sink, reservation, signal } = options;
  const partitions = options.partitions.map((value) => ({
    root: resolve(value.root),
    input: LeagueCloudInputSchema.parse(value.input),
  }));
  signal?.throwIfAborted();
  const provenance = await multipartDiagnosticRuntime(distribution, identity);
  const inventory = await multipartDiagnosticInventory(
    partitions,
    identity,
    runner,
    options.runners,
  );
  const planIds = new Set(partitions.map((value) => value.input.plan.id));
  if (planIds.size !== 1) throw new Error('Multipart mixed prepared plans');
  const chunks = [];
  for (const file of inventory.files) {
    signal?.throwIfAborted();
    const data = await readBoundedFile(file.source, file.bytes);
    if (data.length !== file.bytes || sha256(data) !== file.checksum)
      throw new Error('Multipart sealed producer changed');
    chunks.push(data);
  }
  const payload = Buffer.concat(chunks, inventory.rawBytes);
  const binding = {
    identity,
    runner,
    index: 0,
    count: 1,
    totalBytes: payload.length,
    planHash: partitions[0]!.input.plan.id,
    inventoryHash: inventory.inventoryHash,
    streamHash: sha256(payload),
    runtimeHash: provenance.runtimeHash,
  };
  const expected = { ...binding, payloadHash: sha256(payload) };
  const directory = await mkdtemp(join(tmpdir(), 'fantasy-multipart-v3-'));
  try {
    const received = await sealedZipSegmentDiagnostic({
      directory,
      payload,
      binding,
      expected,
      sourceSha: identity.source.sha,
      prefix: `league-${identity.runId}-${identity.runAttempt}`,
      reservation,
      localOnly: true,
      sink,
      ...(signal ? { signal } : {}),
      allocationAttempt: options.allocationAttempt ?? 0,
    });
    signal?.throwIfAborted();
    if (
      received.payload.length !== binding.totalBytes ||
      sha256(received.payload) !== binding.streamHash
    )
      throw new Error('Multipart incomplete/corrupt stream');
    const verified = await receiveMultipartDiagnostic(
      join(directory, 'restored'),
      inventory,
      received.payload,
      partitions,
    );
    const after = await multipartDiagnosticInventory(partitions, identity, runner, options.runners);
    const nextRuntime = await multipartDiagnosticRuntime(distribution, identity);
    if (
      after.inventoryHash !== inventory.inventoryHash ||
      nextRuntime.runtimeHash !== provenance.runtimeHash
    )
      throw new Error('Multipart inventory/runtime changed');
    signal?.throwIfAborted();
    return {
      mode: 'off' as const,
      executionEnabled: false as const,
      schemaVersion: 3 as const,
      verified,
      transport: { ...received, payload: undefined },
      reservation: reservation.snapshot(),
      runtime: provenance.runtime,
      sourceSha: identity.source.sha,
      remainingGates: [
        'authenticated-producer-execution-and-replay-validation-proofs',
        'authenticated-same-source-main-ci-and-fresh-runtime-bootstrap',
        'multi-segment-production-stream-and-queue-rss',
        'public-sdk-service-version7-compatibility',
        'metadata-http-retry-lease-storage-budget',
        'same-source-whole-critical-path',
      ],
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
