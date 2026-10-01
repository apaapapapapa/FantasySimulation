import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vite-plus/test';
import {
  canonicalJson,
  replayChunkRecords,
  replayContext,
  seekReplayState,
} from '@fantasy/domain/spatial';
import { prepareBattle, runPreparedBattle } from '@fantasy/engine/spatial';
import { ReplayWriter } from '../../../api/src/replay/replay-writer.ts';
import { environmentalHologramManifest } from '../../../../packages/engine/test-support/environmental-holograms.ts';
import {
  ManifestBuilder,
  sealRevision,
} from '../../../../packages/engine/src/spatial/manifest-builder.ts';
import type { OpenedReplay } from './open-replay.ts';
import { ReplayPlayer } from './replay-player.ts';

it('restores an actual multi-chunk hologram recording forward, reverse and across a loop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hologram-replay-'));
  try {
    let input = await environmentalHologramManifest(300);
    const oldAbility = input.revisions.find(
      (revision) => revision.kind === 'ability' && revision.id === 'sk07-hologram',
    );
    if (!oldAbility || oldAbility.kind !== 'ability') throw new Error('Missing hologram ability');
    const ability = await sealRevision('ability', oldAbility.id, oldAbility.revision, {
      ...oldAbility.definition,
      effects: oldAbility.definition.effects.map((effect) =>
        effect.kind === 'environmental-hologram' ? { ...effect, durationSteps: 300 } : effect,
      ),
    });
    input = await ManifestBuilder.relink(input, [{ from: oldAbility, to: ability }]);
    const battle = await prepareBattle(input);
    const output = await runPreparedBattle(battle);
    const writer = await ReplayWriter.create(root, {
      id: 'hologram-player',
      attemptId: 'attempt-1',
      simulationHash: output.result.simulationHash,
      input: battle.manifest,
    });
    for (const record of output.records) await writer.append(record);
    const manifest = await writer.finish({ kind: 'result', result: output.result }, 'result-1');
    expect(manifest.chunks.length).toBeGreaterThan(1);
    const directory = join(root, 'hologram-player');
    const context = await replayContext(battle.manifest, manifest.simulationHash);
    const checkpoints = (index: number) =>
      readFile(join(directory, manifest.checkpoints[index]!.file)).then((bytes) =>
        JSON.parse(gunzipSync(bytes).toString()),
      );
    const records = (index: number) =>
      readFile(join(directory, manifest.chunks[index]!.file)).then((bytes) =>
        replayChunkRecords(gunzipSync(bytes).toString(), manifest.chunks[index]!),
      );
    const opened: OpenedReplay = {
      manifest,
      context,
      records,
      seek: (nextRecord) =>
        seekReplayState(context, manifest, nextRecord, { checkpoint: checkpoints, records }),
    };
    const player = new ReplayPlayer(opened);
    const expected = new Map<number, string>();
    for (const step of [0, 100, 275])
      expected.set(step, canonicalJson((await player.frame(step)).checkpoint));
    const sequence = [0, 100, 275, 0, 275, 100];
    const actual = [];
    for (const step of sequence) actual.push(canonicalJson((await player.frame(step)).checkpoint));
    expect(actual).toEqual(sequence.map((step) => expected.get(step)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
