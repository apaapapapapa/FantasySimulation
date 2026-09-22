import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBattle, catalogManifest, runPreparedBattle } from '@fantasy/engine/spatial';
import { ReplayWriter } from '../src/replay-writer.ts';
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
