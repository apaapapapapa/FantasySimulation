import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  parseJson,
  replayContext,
  ReplayState,
  ReplayManifestSchema,
  eventHashLine,
  trajectoryHashLine,
  type ReplayManifest,
  type StreamRecord,
} from '@fantasy/domain/spatial';
import { readBoundedFile, readCompressed, replayDirectory, sha256 } from './replay-files.ts';

export async function readReplayManifest(
  root: string,
  id: string,
  expectedChecksum?: string,
): Promise<ReplayManifest> {
  const directory = replayDirectory(root, id);
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid replay directory');
  const bytes = await readBoundedFile(join(directory, 'manifest.json'), 4_000_000);
  if (expectedChecksum !== undefined && sha256(bytes) !== expectedChecksum)
    throw new Error('Manifest checksum mismatch');
  const manifest = parseJson(
    ReplayManifestSchema,
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
  );
  if (manifest.id !== id) throw new Error('Replay ID mismatch');
  return manifest;
}
export async function readReplayChunk(directory: string, manifest: ReplayManifest, index: number) {
  const ref = manifest.chunks[index];
  if (!ref) throw new Error('Unknown replay chunk');
  const text = await readCompressed(directory, ref);
  if (!text.endsWith('\n')) throw new Error('Incomplete NDJSON chunk');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== ref.records) throw new Error('Replay chunk record count');
  return lines.map((line): unknown => JSON.parse(line));
}
/** Full verification precedes cache use or publication. No combat/physics execution. */
export async function verifyReplayDirectory(directory: string, manifest: ReplayManifest) {
  const context = await replayContext(manifest.input, manifest.simulationHash);
  const replay = new ReplayState(context),
    events = createHash('sha256'),
    trajectory = createHash('sha256');
  for (const [i, ref] of manifest.chunks.entries()) {
    const checkpoint = JSON.parse(
      await readCompressed(directory, manifest.checkpoints[i]!),
    ) as unknown;
    if (canonicalJson(checkpoint) !== canonicalJson(replay.checkpoint()))
      throw new Error('Checkpoint does not match the verified prefix');
    const records = await readReplayChunk(directory, manifest, i);
    for (const input of records) {
      const record = replay.apply(input);
      if ('events' in record)
        for (const event of record.events) events.update(eventHashLine(event));
      trajectory.update(trajectoryHashLine(record));
    }
    if (replay.step !== ref.toStep) throw new Error('Replay chunk step range');
  }
  const checkpoint = replay.checkpoint();
  if (
    checkpoint.nextRecord !== manifest.records ||
    (checkpoint.state === null ? null : checkpoint.step) !== manifest.lastVerifiedStep ||
    `sha256:${events.digest('hex')}` !== manifest.eventHash ||
    `sha256:${trajectory.digest('hex')}` !== manifest.trajectoryHash
  )
    throw new Error('Replay content digest/range mismatch');
  if (manifest.end.kind === 'result') {
    if (
      checkpoint.lastRecord?.kind !== 'terminal' ||
      canonicalJson(checkpoint.lastRecord.outcome) !== canonicalJson(manifest.end.result.outcome)
    )
      throw new Error('Replay terminal/result mismatch');
  } else if (replay.ended) throw new Error('Diagnostic cannot replace a recorded result');
  return checkpoint;
}
export async function verifyReplay(root: string, id: string) {
  const manifest = await readReplayManifest(root, id);
  const checkpoint = await verifyReplayDirectory(replayDirectory(root, id), manifest);
  return { manifest, checkpoint };
}
/** Load one independent chunk for a seek. Authenticity still requires trusted manifest/checksums. */
export async function seekReplay(root: string, id: string, nextRecord: number) {
  const manifest = await readReplayManifest(root, id);
  if (!Number.isSafeInteger(nextRecord) || nextRecord < 0 || nextRecord > manifest.records)
    throw new Error('Invalid seek cursor');
  const context = await replayContext(manifest.input, manifest.simulationHash);
  if (!manifest.chunks.length) return new ReplayState(context).checkpoint();
  let index = manifest.chunks.findLastIndex((c) => c.firstRecord <= nextRecord);
  index = Math.max(0, index);
  const directory = replayDirectory(root, id);
  const checkpoint = JSON.parse(
    await readCompressed(directory, manifest.checkpoints[index]!),
  ) as unknown;
  const replay = new ReplayState(context, checkpoint),
    ref = manifest.chunks[index]!;
  if (replay.checkpoint().nextRecord !== ref.firstRecord || replay.step !== ref.fromStep)
    throw new Error('Seek checkpoint index mismatch');
  const records = await readReplayChunk(directory, manifest, index);
  for (const record of records.slice(0, nextRecord - ref.firstRecord)) replay.apply(record);
  return replay.checkpoint();
}

export const recordEvents = (record: StreamRecord) => ('events' in record ? record.events : []);
