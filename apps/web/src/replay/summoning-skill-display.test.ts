import { expect, it } from 'vite-plus/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ManifestSchema,
  replayChunkRecords,
  replayContext,
  seekReplayState,
} from '@fantasy/domain/spatial';
import { ManifestBuilder, runBattle } from '@fantasy/engine/spatial';
import { catalogManifest, sampleCatalog } from '@fantasy/samples';
import { recordedCheckpoints } from '../../../../packages/engine/test-support/replay.ts';
import { ReplayWriter } from '../../../api/src/replay/replay-writer.ts';
import fixture from '../../../../packages/engine/fixtures/spatial/summoning-rat-dan1-runtime-v1.json' with { type: 'json' };
import { buildSceneModel } from './scene-model.ts';
import { Scene2D } from './Scene2D.tsx';
import { Dependents3D } from './SceneEffects.tsx';
import { NO_OVERLAYS } from './overlays.ts';
import { expandArtifact } from './artifacts.ts';
import type { OpenedReplay } from './open-replay.ts';
import { ReplayPlayer } from './replay-player.ts';
import { skillReceipt } from './skill-display-test-support.ts';

async function productionSummonBattle() {
  const source = await catalogManifest(
      'swordsman',
      'swordsman',
      'flat',
      6000,
      228,
      fixture.ruleset.id,
    ),
    ability = (await sampleCatalog()).find(
      (revision) => revision.kind === 'ability' && revision.id === fixture.ability.id,
    );
  if (ability?.kind !== 'ability') throw new Error('Missing production rat ability');
  expect({ id: ability.id, revision: ability.revision, contentHash: ability.contentHash }).toEqual(
    fixture.ability,
  );
  const receipt = await skillReceipt({
      character: source.participants[0]!.character,
      catalogRevision: 8,
      loadoutId: 'loadout.production.summoning.rat.1',
      nodeId: fixture.catalogNodeId,
      ability: fixture.ability,
    }),
    participants = structuredClone(source.participants);
  participants[0]!.skillLoadout = receipt;
  return ManifestBuilder.from([...source.revisions, ability]).build({
    seed: source.seed,
    participants,
    ruleset: source.ruleset,
    scenario: source.scenario,
  });
}

it('projects one production saved-rat checkpoint through the same 3D and 2D model', async () => {
  const battle = await productionSummonBattle(),
    output = await runBattle(battle.manifest),
    saved = await recordedCheckpoints(ManifestSchema.parse(battle.manifest), output),
    active = saved.checkpoints.find((checkpoint) => checkpoint.state?.dependents?.length);
  if (!active?.state?.dependents?.length) throw new Error('Missing production rat checkpoint');
  expect(active.step).toBe(fixture.expected.activeReplayStep);
  expect(battle.manifest.schemaVersion).toBe(fixture.expected.manifestSchemaVersion);
  expect(battle.manifest.ruleset).toEqual(fixture.ruleset);

  const display = active.state.dependents[0]!,
    model = buildSceneModel(saved.context, active),
    dependent = model.dependents.find(({ id }) => id === display.id);
  expect(dependent).toMatchObject({
    id: display.id,
    ownerId: display.ownerId,
    hostileOwnerId: display.hostileOwnerId,
    position: [display.position.x, display.position.y, display.position.z],
    hp: { value: display.hp, max: display.maxHp },
    profile: fixture.recipe.profile,
  });
  const three = renderToStaticMarkup(createElement(Dependents3D, { model })),
    two = renderToStaticMarkup(createElement(Scene2D, { model, overlays: NO_OVERLAYS }));
  expect(three).toContain(`data-dependent="${display.id}"`);
  expect(two).toContain(`data-dependent="${display.id}"`);

  const final = buildSceneModel(saved.context, saved.checkpoints.at(-1)!);
  expect(final.dependents).toHaveLength(0);
});

it('restores production rat transitions through ReplayWriter and ReplayPlayer in both directions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'summoning-rat-player-'));
  try {
    const battle = await productionSummonBattle(),
      output = await runBattle(battle.manifest),
      writer = await ReplayWriter.create(root, {
        id: 'summoning-rat-player',
        attemptId: 'attempt-1',
        simulationHash: output.result.simulationHash,
        input: battle.manifest,
      });
    let forcedDependentBoundary = false;
    for (const record of output.records) {
      await writer.append(record);
      if (
        !forcedDependentBoundary &&
        record.kind !== 'initial' &&
        record.kind !== 'terminal' &&
        record.dependents?.update.length
      ) {
        await (writer as unknown as { flush(): Promise<void> }).flush();
        forcedDependentBoundary = true;
      }
    }
    expect(forcedDependentBoundary).toBe(true);
    const manifest = await writer.finish({ kind: 'result', result: output.result }, 'result-1'),
      directory = join(root, manifest.id),
      context = await replayContext(battle.manifest, manifest.simulationHash),
      checkpoints = async (index: number) => {
        const ref = manifest.checkpoints[index]!;
        return JSON.parse(
          await expandArtifact(new Uint8Array(await readFile(join(directory, ref.file))), ref),
        );
      },
      records = async (index: number) => {
        const ref = manifest.chunks[index]!;
        return replayChunkRecords(
          await expandArtifact(new Uint8Array(await readFile(join(directory, ref.file))), ref),
          ref,
        );
      },
      opened: OpenedReplay = {
        manifest,
        context,
        records,
        seek: (nextRecord) =>
          seekReplayState(context, manifest, nextRecord, { checkpoint: checkpoints, records }),
      },
      player = new ReplayPlayer(opened),
      spawnRecordIndex = output.records.findIndex(
        (record) =>
          record.kind !== 'initial' &&
          record.kind !== 'terminal' &&
          record.dependents?.spawn.length,
      ),
      dependentId = output.records
        .flatMap((record) => ('events' in record ? record.events : []))
        .find(({ kind }) => kind === 'dependent-create')?.entityId,
      activeStep = output.records.find(
        (record) =>
          record.kind !== 'initial' &&
          record.kind !== 'terminal' &&
          record.dependents?.update.some(({ id }) => id === dependentId),
      ),
      expiryStep = output.records.find(
        (record) =>
          record.kind !== 'initial' &&
          record.kind !== 'terminal' &&
          record.dependents?.remove.some(
            ({ id, reason }) => id === dependentId && reason === 'expired',
          ),
      );
    if (spawnRecordIndex < 0 || !dependentId || !activeStep || !expiryStep)
      throw new Error('Missing saved rat transitions');
    expect(manifest.chunks.length).toBeGreaterThan(1);
    const transitionRecordIndexes = [
        spawnRecordIndex,
        output.records.indexOf(activeStep),
        output.records.indexOf(expiryStep),
      ],
      transitionChunkIndexes = transitionRecordIndexes.map(
        (recordIndex) =>
          manifest.chunks.find(
            (chunk) =>
              chunk.firstRecord <= recordIndex && recordIndex < chunk.firstRecord + chunk.records,
          )?.index,
      );
    expect(transitionChunkIndexes.every((index) => index !== undefined)).toBe(true);
    expect(new Set(transitionChunkIndexes).size).toBeGreaterThan(1);
    const step = (record: typeof activeStep) =>
      record.kind === 'interval' ? record.toStep : record.step;
    const active = step(activeStep),
      expired = step(expiryStep),
      expected = await player.frame(active);
    expect(expected.checkpoint.state?.dependents?.map(({ id }) => id)).toEqual([dependentId]);
    const history = [
      {
        id: dependentId,
        ownerId: expected.checkpoint.state!.dependents![0]!.ownerId,
        hostileOwnerId: expected.checkpoint.state!.dependents![0]!.hostileOwnerId,
      },
    ];
    expect(expected.checkpoint.dependentHistory).toEqual(history);
    for (const target of [expired, active, 0, active, manifest.lastVerifiedStep!]) {
      const frame = await player.frame(target);
      expect(frame.checkpoint.state?.dependents ?? []).toHaveLength(target === active ? 1 : 0);
      if (target === 0) expect(frame.checkpoint).not.toHaveProperty('dependentHistory');
      else expect(frame.checkpoint.dependentHistory).toEqual(history);
    }
    const model = buildSceneModel(context, expected.checkpoint);
    expect(model.dependents.map(({ id }) => id)).toEqual([dependentId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
