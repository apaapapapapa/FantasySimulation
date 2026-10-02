import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vite-plus/test';
import { ManifestSchema, revisionReference } from '@fantasy/domain/spatial';
import { ManifestBuilder, runBattle } from '@fantasy/engine/spatial';
import { catalogManifest, sampleCatalog } from '@fantasy/samples';
import { initialStatus, withInitialStatus } from '../../../../packages/engine/test-support/ai.ts';
import { ReplayWriter } from '../../../api/src/replay/replay-writer.ts';
import { Scene2D } from './Scene2D.tsx';
import { Dependents3D } from './SceneEffects.tsx';
import { NO_OVERLAYS } from './overlays.ts';
import { openReplay } from './open-replay.ts';
import { ReplayPlayer } from './replay-player.ts';
import { buildSceneModel } from './scene-model.ts';
import { skillReceipt } from './skill-display-test-support.ts';

const nodeId = 'skill.magic.goat.1';
const abilityId = 'self-water';

async function productionGoatBattle() {
  const source = await catalogManifest('swordsman', 'swordsman', 'flat', 40, 42),
    burn = await withInitialStatus(
      source,
      0,
      initialStatus({
        stackKey: 'goat-water-extinguishable-burn',
        burning: { waterExtinguishable: true },
        periodic: [{ kind: 'damage', amount: 1, element: 'fire', everySteps: 10 }],
      }),
    ),
    ability = (await sampleCatalog()).find(
      (revision) => revision.kind === 'ability' && revision.id === abilityId,
    );
  if (ability?.kind !== 'ability') throw new Error('Missing production self-water');
  const receipt = await skillReceipt({
      character: source.participants[0]!.character,
      catalogRevision: 9,
      loadoutId: 'loadout.production.magic.goat.1',
      nodeId,
      ability: revisionReference(ability),
    }),
    participants = structuredClone(source.participants);
  participants[0]!.skillLoadout = receipt;
  const battle = await ManifestBuilder.from([...source.revisions, ability]).build({
    seed: source.seed,
    participants,
    ruleset: source.ruleset,
    scenario: source.scenario,
  });
  return { manifest: battle.manifest, burn };
}

it('seeks goat extinguish forward reverse and loop through shared 2D/3D ReplayState', async () => {
  const root = await mkdtemp(join(tmpdir(), 'magic-goat-player-'));
  try {
    const battle = await productionGoatBattle(),
      output = await runBattle(battle.manifest),
      removal = output.records
        .flatMap((record) => ('events' in record ? record.events : []))
        .find(
          (event) =>
            event.kind === 'status-remove' && event.reason === `${battle.burn.id}:dispel-existing`,
        );
    if (!removal) throw new Error('Missing production goat extinguish');
    const input = ManifestSchema.parse(battle.manifest),
      writer = await ReplayWriter.create(root, {
        id: 'magic-goat-player',
        attemptId: 'attempt-1',
        simulationHash: output.result.simulationHash,
        input,
      });
    for (const record of output.records) await writer.append(record);
    const manifest = await writer.finish({ kind: 'result', result: output.result }, 'result-1'),
      directory = join(root, manifest.id),
      opened = await openReplay({
        manifest: async () => manifest,
        file: async (ref) => new Uint8Array(await readFile(join(directory, ref.file))),
      }),
      player = new ReplayPlayer(opened),
      beforeStep = Math.max(0, removal.step - 1);
    for (const target of [
      beforeStep,
      removal.step,
      beforeStep,
      manifest.lastVerifiedStep!,
      removal.step,
    ]) {
      const frame = await player.frame(target),
        checkpoint = frame.checkpoint,
        left = checkpoint.state?.actors.find(({ id }) => id === 'left'),
        hasBurn = left?.statuses.some(({ revision }) => revision.id === battle.burn.id),
        model = buildSceneModel(opened.context, checkpoint, frame.records, frame.events),
        two = renderToStaticMarkup(createElement(Scene2D, { model, overlays: NO_OVERLAYS })),
        three = renderToStaticMarkup(createElement(Dependents3D, { model }));
      expect(hasBurn).toBe(target < removal.step);
      expect(model.actors.map(({ id }) => id)).toEqual(['left', 'right']);
      expect(two).toContain('left');
      // Self-water owns no dependent geometry; this is a 3D shared-model smoke assertion only.
      expect(three).toBe('');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
