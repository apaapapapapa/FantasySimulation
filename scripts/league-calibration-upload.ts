import artifact from '@actions/artifact';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';
import { executionSource, measureAsync, currentMeasurements } from '@fantasy/api/tooling';
import { artifactDigest } from './league-artifact-policy.ts';
import { requiredPipeline } from './league-pipeline-context.ts';
import {
  CALIBRATION_LIMITS,
  validateCalibrationBudget,
} from './league-runner-calibration-policy.ts';
import type { PipelineArtifact } from './league-pipeline-artifacts.ts';
import {
  calibrationTransportReservation,
  type TransportReservation,
} from './league-transport-reservation.ts';

let partition: number | undefined;
const reserved = new Map<string, number>();
let transport: TransportReservation | undefined;
let globalRefsUpper: number | undefined;
let transportCommand: string | undefined;
let transportPrefix: string | undefined;
let transportSourceSha: string | undefined;
export function beginCalibrationTransportJob(
  command: string,
  runners: number,
  prefix: string,
  existingArtifacts: number,
) {
  if (transport) throw new Error('Calibration transport job already reserved');
  if (!/^league-[1-9][0-9]*-[1-9][0-9]*$/.test(prefix))
    throw new Error('Invalid calibration transport identity');
  const reservation = calibrationTransportReservation(command, runners, existingArtifacts);
  transport = reservation.ledger;
  globalRefsUpper = reservation.globalRefsUpper;
  transportCommand = command;
  transportPrefix = prefix;
  transportSourceSha = executionSource().sha;
}
export function calibrationTransportSnapshot() {
  return transport
    ? {
        ...transport.snapshot(),
        globalRefsUpper,
        sourceSha: transportSourceSha,
        scope: 'before final metrics allocation',
      }
    : null;
}
export function setCalibrationPartition(index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= 4)
    throw new Error('Foreign calibration partition');
  partition = index;
}

/** Uses the installed pinned SDK encoder locally; never creates an artifact or contacts a service. */
export async function calibrationArchiveStream(files: string[], root: string) {
  const sdkRoot = dirname(fileURLToPath(import.meta.resolve('@actions/artifact')));
  const manifest = JSON.parse(await readFile(join(sdkRoot, '../package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (manifest.version !== '6.2.1')
    throw new Error('Calibration requires the reviewed artifact SDK');
  const specification = (await import(
    pathToFileURL(join(sdkRoot, 'internal/upload/upload-zip-specification.js')).href
  )) as {
    getUploadZipSpecification(files: string[], root: string): unknown;
  };
  const encoder = (await import(pathToFileURL(join(sdkRoot, 'internal/upload/zip.js')).href)) as {
    createZipUploadStream(spec: unknown, level: number): Promise<Readable>;
  };
  return encoder.createZipUploadStream(specification.getUploadZipSpecification(files, root), 0);
}

export async function calibrationEncodedBytes(files: string[], root: string, limit: number) {
  const stream = await calibrationArchiveStream(files, root);
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk);
      if (!Number.isSafeInteger(bytes) || bytes > limit)
        throw new Error('Calibration encoded-byte bound before service allocation');
    }
    return bytes;
  } finally {
    stream.destroy();
  }
}

export async function uploadCalibrationArtifact(
  name: string,
  files: string[],
  root: string,
): Promise<PipelineArtifact> {
  if (!transport) throw new Error('Calibration transport requires a pre-reserved job');
  if (executionSource().sha !== transportSourceSha)
    throw new Error('Calibration transport source changed');
  if (!name.startsWith(transportPrefix + '-'))
    throw new Error('Foreign calibration transport identity');
  validateCalibrationBudget(
    JSON.parse(requiredPipeline('LEAGUE_CALIBRATION_BUDGET')),
    executionSource().sha,
  );
  if (
    !/^league-[a-zA-Z0-9-]+$/.test(name) ||
    files.length < 1 ||
    files.length > 4096 ||
    new Set(files).size !== files.length
  )
    throw new Error('Invalid calibration upload');
  let category: string, rawLimit: number, encodedLimit: number;
  if (name.endsWith('-inputs') || name.endsWith('-baseline')) {
    category = name.endsWith('-inputs') ? 'inputs' : 'baseline';
    rawLimit = CALIBRATION_LIMITS.rawSharedBytes;
    encodedLimit = CALIBRATION_LIMITS.encodedSharedBytes;
  } else if (name.endsWith('-metrics')) {
    category = 'metrics';
    rawLimit = 400000;
    encodedLimit = CALIBRATION_LIMITS.encodedMetricsBytes;
  } else if (/-terminal-[0-3]$/.test(name)) {
    category = 'terminal';
    rawLimit = 200000;
    encodedLimit = CALIBRATION_LIMITS.encodedTerminalBytes;
  } else {
    if (partition === undefined) throw new Error('Calibration payload lacks partition accounting');
    category = `partition-${partition}`;
    rawLimit = CALIBRATION_LIMITS.rawPartitionBytes;
    encodedLimit = CALIBRATION_LIMITS.encodedPartitionBytes;
  }
  if (
    (transportCommand === 'prepare' && !['inputs', 'baseline', 'metrics'].includes(category)) ||
    (transportCommand === 'consume' && category !== 'metrics') ||
    (transportCommand === 'compute' && ['inputs', 'baseline'].includes(category))
  )
    throw new Error('Foreign calibration transport job category');
  const used = reserved.get(category) ?? 0;
  // SDK creates one ZIP/body only after Create succeeds. HTTP retries do not multiply stored payload bytes.
  const serviceAttempts = 1;
  const available = Math.floor((encodedLimit - used) / serviceAttempts);
  if (available < 1) throw new Error('Calibration aggregate archive budget exhausted');
  const directory = await realpath(resolve(root));
  let rawBytes = 0;
  const snapshots = [];
  for (const path of files) {
    const key = relative(directory, resolve(path)),
      info = await lstat(path);
    if (
      !key ||
      key.startsWith('..') ||
      key.includes('\\') ||
      !info.isFile() ||
      (await realpath(path)) !== resolve(path) ||
      Buffer.byteLength(key) > 256
    )
      throw new Error('Unsafe calibration file');
    rawBytes += info.size;
    snapshots.push({ path, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino });
  }
  if (!Number.isSafeInteger(rawBytes) || rawBytes > rawLimit)
    throw new Error('Calibration raw-byte bound');
  const encodedBytes = await measureAsync('artifact.zipPreflight', () =>
    calibrationEncodedBytes(files, directory, available),
  );
  for (const snapshot of snapshots) {
    const info = await lstat(snapshot.path);
    if (
      !info.isFile() ||
      info.size !== snapshot.size ||
      info.mtimeMs !== snapshot.mtimeMs ||
      info.ino !== snapshot.ino
    )
      throw new Error('Calibration sealed files changed during ZIP preflight');
  }
  // Reserve before any SDK service allocation; a failed/uncertain request never refunds this reservation.
  const latestUsed = reserved.get(category) ?? 0;
  if (latestUsed + encodedBytes * serviceAttempts > encodedLimit)
    throw new Error('Calibration concurrent archive reservation exceeds aggregate bound');
  transport.reserve(name, encodedBytes * serviceAttempts);
  reserved.set(category, latestUsed + encodedBytes * serviceAttempts);
  const uploaded = await measureAsync('artifact.upload', () =>
    artifact.uploadArtifact(name, files, directory, { retentionDays: 1, compressionLevel: 0 }),
  );
  currentMeasurements()?.addBytes('artifact.upload', rawBytes);
  if (!uploaded.id || uploaded.size !== encodedBytes)
    throw new Error('Calibration encoded archive changed or acknowledgement missing');
  return { id: uploaded.id, name, digest: artifactDigest(uploaded.digest), bytes: uploaded.size };
}
