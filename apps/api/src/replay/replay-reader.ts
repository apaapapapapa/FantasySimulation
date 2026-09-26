import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { OperationError, operationInput } from '../operation-error.ts';
import {
  canonicalJson,
  parseJson,
  replayChunkRecords,
  replayContext,
  ReplayState,
  ReplayManifestSchema,
  eventHashLine,
  MAX_REPLAY_MANIFEST_BYTES,
  seekReplayState,
  trajectoryHashLine,
  type ReplayManifest,
  type StreamRecord,
} from '@fantasy/domain/spatial';
import { readBoundedFile, readCompressed, replayDirectory, sha256 } from './replay-files.ts';

// Bump when semantic acceptance changes. Only this full validator can issue the receipt.
export const REPLAY_VALIDATION_PROFILE = 'record-validation-v1';
const verifiedManifests = new WeakMap<ReplayManifest, string>();
export function replayValidationProfile(manifest: ReplayManifest) {
  return verifiedManifests.get(manifest) === sha256(canonicalJson(manifest))
    ? REPLAY_VALIDATION_PROFILE
    : null;
}
/** Trusted DB receipts bind prior semantic verification to these exact compressed bytes. */
export async function verifyReplayChecksums(directory: string, manifest: ReplayManifest) {
  for (const ref of [...manifest.chunks, ...manifest.checkpoints]) {
    const bytes = await readBoundedFile(join(directory, ref.file), ref.bytes);
    if (bytes.length !== ref.bytes || sha256(bytes) !== ref.checksum)
      throw new OperationError('DATA_INVALID', 'Replay file size or checksum mismatch');
  }
}

export async function readReplayManifest(
  root: string,
  id: string,
  expectedChecksum?: string,
): Promise<ReplayManifest> {
  const directory = replayDirectory(root, id);
  if (!(await lstat(directory)).isDirectory())
    throw new OperationError('DATA_INVALID', 'Invalid replay directory');
  const bytes = await readBoundedFile(join(directory, 'manifest.json'), MAX_REPLAY_MANIFEST_BYTES);
  if (expectedChecksum !== undefined && sha256(bytes) !== expectedChecksum)
    throw new OperationError('DATA_INVALID', 'Manifest checksum mismatch');
  const manifest = operationInput(
    () =>
      parseJson(
        ReplayManifestSchema,
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
      ),
    'DATA_INVALID',
  );
  if (manifest.id !== id) throw new OperationError('DATA_INVALID', 'Replay ID mismatch');
  return manifest;
}
export async function readReplayChunk(directory: string, manifest: ReplayManifest, index: number) {
  const ref = manifest.chunks[index];
  if (!ref) throw new Error('Unknown replay chunk');
  const raw = await readCompressed(directory, ref);
  return operationInput(() => replayChunkRecords(raw, ref), 'DATA_INVALID');
}
const readCheckpoint = async (directory: string, manifest: ReplayManifest, index: number) => {
  const raw = await readCompressed(directory, manifest.checkpoints[index]!);
  return operationInput(() => JSON.parse(raw) as unknown, 'DATA_INVALID');
};
/** Full verification precedes writing, untrusted import/publication and legacy receipt adoption. */
export async function verifyReplayDirectory(directory: string, manifest: ReplayManifest) {
  const context = await replayContext(manifest.input, manifest.simulationHash);
  const replay = new ReplayState(context),
    events = createHash('sha256'),
    trajectory = createHash('sha256');
  for (const [i, ref] of manifest.chunks.entries()) {
    const checkpoint = await readCheckpoint(directory, manifest, i);
    if (canonicalJson(checkpoint) !== canonicalJson(replay.checkpoint()))
      throw new OperationError('DATA_INVALID', 'Checkpoint does not match the verified prefix');
    const records = await readReplayChunk(directory, manifest, i);
    for (const input of records) {
      const record = operationInput(() => replay.apply(input), 'DATA_INVALID');
      if ('events' in record)
        for (const event of record.events) events.update(eventHashLine(event));
      trajectory.update(trajectoryHashLine(record));
    }
    if (replay.step !== ref.toStep)
      throw new OperationError('DATA_INVALID', 'Replay chunk step range');
  }
  const checkpoint = replay.checkpoint();
  if (
    checkpoint.nextRecord !== manifest.records ||
    (checkpoint.state === null ? null : checkpoint.step) !== manifest.lastVerifiedStep ||
    `sha256:${events.digest('hex')}` !== manifest.eventHash ||
    `sha256:${trajectory.digest('hex')}` !== manifest.trajectoryHash
  )
    throw new OperationError('DATA_INVALID', 'Replay content digest/range mismatch');
  if (manifest.end.kind === 'result') {
    if (
      checkpoint.lastRecord?.kind !== 'terminal' ||
      canonicalJson(checkpoint.lastRecord.outcome) !== canonicalJson(manifest.end.result.outcome)
    )
      throw new OperationError('DATA_INVALID', 'Replay terminal/result mismatch');
  } else if (replay.ended)
    throw new OperationError('DATA_INVALID', 'Diagnostic cannot replace a recorded result');
  verifiedManifests.set(manifest, sha256(canonicalJson(manifest)));
  return checkpoint;
}
export async function verifyReplay(root: string, id: string) {
  const manifest = await readReplayManifest(root, id);
  const checkpoint = await verifyReplayDirectory(replayDirectory(root, id), manifest);
  return { manifest, checkpoint };
}
/** Load one independent chunk for a seek. Authenticity still requires trusted manifest/checksums. */
export async function seekReplay(root: string, id: string, nextRecord: number) {
  const manifest = await readReplayManifest(root, id),
    directory = replayDirectory(root, id);
  const context = await replayContext(manifest.input, manifest.simulationHash);
  const replay = await seekReplayState(context, manifest, nextRecord, {
    checkpoint: (index) => readCheckpoint(directory, manifest, index),
    records: (index) => readReplayChunk(directory, manifest, index),
  });
  return replay.checkpoint();
}

export const recordEvents = (record: StreamRecord) => ('events' in record ? record.events : []);
