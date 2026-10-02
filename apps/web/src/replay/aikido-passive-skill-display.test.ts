import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vite-plus/test';
import { revisionReference } from '@fantasy/domain/spatial';
import { ManifestBuilder, runBattle } from '@fantasy/engine/spatial';
import { catalogManifest, sampleCatalog } from '@fantasy/samples';
import { ReplayWriter } from '../../../api/src/replay/replay-writer.ts';
import { EventEntries } from './EventEntries.tsx';
import { Scene2D } from './Scene2D.tsx';
import { Dependents3D } from './SceneEffects.tsx';
import { SkillProvenance, skillProvenance } from './SkillProvenance.tsx';
import { NO_OVERLAYS } from './overlays.ts';
import { openReplay } from './open-replay.ts';
import { ReplayPlayer } from './replay-player.ts';
import { buildSceneModel } from './scene-model.ts';
import { skillReceipt } from './skill-display-test-support.ts';

const nodeId = 'skill.aikido.dog.1';
const abilityId = 'parry-v1';

async function productionAikidoBattle() {
  const source = await catalogManifest(
      'posture-duelist-v1',
      'phoenix-duelist-v1',
      'flat',
      200,
      228,
    ),
    parry = (await sampleCatalog()).find(
      (revision) => revision.kind === 'ability' && revision.id === abilityId,
    );
  if (parry?.kind !== 'ability') throw new Error('Missing production Aikido passive');
  const receipt = await skillReceipt({
      character: source.participants[0]!.character,
      catalogRevision: 10,
      loadoutId: 'loadout.production.aikido.dog.1.passive',
      nodeId,
      ability: revisionReference(parry),
      kind: 'passive-ability',
    }),
    participants = structuredClone(source.participants);
  participants[0]!.skillLoadout = receipt;
  const battle = await ManifestBuilder.from([...source.revisions, parry]).build({
    seed: source.seed,
    participants,
    ruleset: source.ruleset,
    scenario: source.scenario,
  });
  return { battle, parry };
}

it('seeks the saved Aikido passive through replay, 2D/3D scenes and provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aikido-passive-player-'));
  try {
    const { battle, parry } = await productionAikidoBattle(),
      output = await runBattle(battle.manifest),
      activation = output.records
        .flatMap((record) => ('events' in record ? record.events : []))
        .find(
          (event) =>
            event.kind === 'reaction' &&
            event.actorId === 'left' &&
            event.abilityId === abilityId &&
            event.ruleId === 'reaction.activated',
        );
    if (!activation) throw new Error('Missing production Aikido reaction');

    const writer = await ReplayWriter.create(root, {
      id: 'aikido-passive-player',
      attemptId: 'attempt-1',
      simulationHash: output.result.simulationHash,
      input: battle.manifest,
    });
    for (const record of output.records) await writer.append(record);
    const manifest = await writer.finish({ kind: 'result', result: output.result }, 'result-1'),
      opened = await openReplay({
        manifest: () => Promise.resolve(manifest),
        file: async ({ file }) => Uint8Array.from(await readFile(join(root, manifest.id, file))),
      }),
      player = new ReplayPlayer(opened),
      beforeStep = Math.max(0, activation.step - 1);

    for (const target of [
      beforeStep,
      activation.step,
      beforeStep,
      manifest.lastVerifiedStep!,
      activation.step,
    ])
      await expect(player.frame(target)).resolves.toBeDefined();

    const before = await player.frame(beforeStep),
      active = await player.frame(activation.step),
      after = await player.frame(manifest.lastVerifiedStep!),
      reactions = (frame: typeof active) =>
        frame.checkpoint.state?.actors
          .find(({ id }) => id === 'left')
          ?.reactions?.filter(({ abilityId: id }) => id === abilityId) ?? [];
    expect(reactions(before)).toHaveLength(0);
    expect(reactions(active)).toEqual(
      expect.arrayContaining([expect.objectContaining({ abilityId, state: 'applied' })]),
    );
    expect(after.checkpoint.step).toBe(manifest.lastVerifiedStep);

    const model = buildSceneModel(opened.context, active.checkpoint, active.records, active.events),
      two = renderToStaticMarkup(createElement(Scene2D, { model, overlays: NO_OVERLAYS })),
      three = renderToStaticMarkup(createElement(Dependents3D, { model })),
      eventHtml = renderToStaticMarkup(
        createElement(EventEntries, {
          events: active.events,
          step: activation.step,
          onSeek() {},
        }),
      ),
      provenanceHtml = renderToStaticMarkup(
        createElement(SkillProvenance, { context: opened.context }),
      );
    expect(model.actors.map(({ id }) => id)).toEqual(['left', 'right']);
    expect(two).toContain('left');
    // The passive owns no dependent body; the 3D shared-model projection must stay empty.
    expect(three).toBe('');
    expect(eventHtml).toContain(activation.id);
    expect(eventHtml).toContain(abilityId);
    expect(skillProvenance(opened.context)[0]?.nodeResolutions).toEqual([
      {
        nodeId,
        resolution: [{ kind: 'passive-ability', ability: revisionReference(parry) }],
      },
    ]);
    expect(provenanceHtml).toContain(nodeId);
    expect(provenanceHtml).toContain(`${abilityId}@1`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
