import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBattle, runPreparedBattle } from '@fantasy/engine/spatial';
import { catalogManifest } from '@fantasy/samples';
import { ReplayWriter } from '../src/replay/replay-writer.ts';
import type { ReplayManifest } from '@fantasy/domain/spatial';

export async function withReplayDirectory(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'fantasy-replays-'));
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
export async function recordedBattle(root: string, maxSteps = 350) {
  const battle = await prepareBattle(await catalogManifest('archer', 'guardian', 'flat', maxSteps));
  const output = await runPreparedBattle(battle);
  const writer = await ReplayWriter.create(root, {
    id: 'replay-test',
    attemptId: 'attempt-test',
    simulationHash: battle.simulationHash,
    input: battle.manifest,
  });
  for (const record of output.records) await writer.append(record);
  const manifest = await writer.finish({ kind: 'result', result: output.result }, 'result-test');
  return { ...output, manifest };
}
export const artifactBytes = (manifest: ReplayManifest) =>
  [...manifest.chunks, ...manifest.checkpoints].reduce((sum, f) => sum + f.bytes, 0);
/** Flips one byte in place through one handle, keeping the file size and mtime unchanged. */
export async function flipFirstByte(path: string) {
  const handle = await open(path, 'r+');
  try {
    const metadata = await handle.stat();
    const first = Buffer.alloc(1);
    await handle.read(first, 0, 1, 0);
    first[0] = first[0]! ^ 1;
    await handle.write(first, 0, 1, 0);
    await handle.utimes(metadata.atime, metadata.mtime);
    if ((await handle.stat()).size !== metadata.size) throw new Error('Same-size change grew');
  } finally {
    await handle.close();
  }
}
