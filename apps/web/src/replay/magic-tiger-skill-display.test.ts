import { expect, it } from 'vite-plus/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { revisionReference } from '@fantasy/domain/spatial';
import { ManifestBuilder, runBattle } from '@fantasy/engine/spatial';
import { catalogManifest, revisionClosure, sampleCatalog } from '@fantasy/samples';
import { ReplayWriter } from '../../../api/src/replay/replay-writer.ts';
import { buildSceneModel } from './scene-model.ts';
import { Scene2D } from './Scene2D.tsx';
import { SceneEffects } from './SceneEffects.tsx';
import { NO_OVERLAYS } from './overlays.ts';
import { openReplay } from './open-replay.ts';
import { ReplayPlayer } from './replay-player.ts';
import { sharedSkillReceipt } from './skill-display-test-support.ts';

const nodes = ['skill.magic.rat.1', 'skill.magic.tiger.1', 'skill.magic.tiger.2'];

async function sharedFlareBattle() {
  const source = await catalogManifest('ember-duelist', 'swordsman', 'flat', 200, 228),
    catalog = await sampleCatalog(),
    flare = catalog.find(
      (revision) => revision.kind === 'ability' && revision.id === 'ordinary-flare',
    ),
    fireball = catalog.find(
      (revision) => revision.kind === 'ability' && revision.id === 'fireball',
    );
  if (flare?.kind !== 'ability' || fireball?.kind !== 'ability')
    throw new Error('Missing magic tiger ability closure');
  const nodeResolutions = [
      {
        nodeId: nodes[0]!,
        resolution: [{ kind: 'active-ability' as const, ability: revisionReference(flare) }],
      },
      {
        nodeId: nodes[1]!,
        resolution: [{ kind: 'active-ability' as const, ability: revisionReference(fireball) }],
      },
      {
        nodeId: nodes[2]!,
        resolution: [{ kind: 'active-ability' as const, ability: revisionReference(flare) }],
      },
    ],
    receipt = await sharedSkillReceipt({
      character: source.participants[0]!.character,
      catalogRevision: 10,
      loadoutId: 'loadout.magic.tiger.shared',
      explicitlyEnabledNodeIds: [nodes[0]!, nodes[2]!],
      nodeResolutions,
    }),
    participants = structuredClone(source.participants),
    closure = revisionClosure(catalog, [
      { kind: 'ability', ref: revisionReference(flare) },
      { kind: 'ability', ref: revisionReference(fireball) },
    ]),
    existing = new Set(
      source.revisions.map((revision) => `${revision.kind}:${revision.id}:${revision.revision}`),
    );
  participants[0]!.skillLoadout = receipt;
  return ManifestBuilder.from([
    ...source.revisions,
    ...closure.filter(
      (revision) => !existing.has(`${revision.kind}:${revision.id}:${revision.revision}`),
    ),
  ]).build({ seed: source.seed, participants, ruleset: source.ruleset, scenario: source.scenario });
}

async function writeFlareReplay(
  root: string,
  battle: Awaited<ReturnType<typeof sharedFlareBattle>>,
  output: Awaited<ReturnType<typeof runBattle>>,
) {
  const writer = await ReplayWriter.create(root, {
    id: 'magic-tiger-player',
    attemptId: 'attempt-1',
    simulationHash: output.result.simulationHash,
    input: battle.manifest,
  });
  let flushed = false;
  for (const record of output.records) {
    await writer.append(record);
    if (!flushed && record.kind === 'interval' && record.projectiles.spawn.length) {
      await (writer as unknown as { flush(): Promise<void> }).flush();
      flushed = true;
    }
  }
  expect(flushed).toBe(true);
  return writer.finish({ kind: 'result', result: output.result }, 'result-1');
}

async function openWrittenReplay(
  root: string,
  manifest: Awaited<ReturnType<typeof writeFlareReplay>>,
) {
  const directory = join(root, manifest.id);
  return openReplay({
    manifest: async () => manifest,
    file: async (ref) => new Uint8Array(await readFile(join(directory, ref.file))),
  });
}

it('replays the shared tiger flare forward reverse and loop through one common 2D/3D scene', async () => {
  const root = await mkdtemp(join(tmpdir(), 'magic-tiger-player-'));
  try {
    const battle = await sharedFlareBattle(),
      output = await runBattle(battle.manifest),
      manifest = await writeFlareReplay(root, battle, output),
      opened = await openWrittenReplay(root, manifest),
      context = opened.context,
      player = new ReplayPlayer(opened),
      activeRecord = output.records.find(
        (record) =>
          record.kind === 'interval' &&
          record.projectiles.spawn.some((projectile) => projectile.abilityId === 'ordinary-flare'),
      );
    if (!activeRecord || activeRecord.kind !== 'interval')
      throw new Error('Missing saved ordinary flare');
    expect(context.actors[0]!.abilities.filter(({ id }) => id === 'ordinary-flare')).toHaveLength(
      1,
    );
    const activeStep = activeRecord.toStep,
      active = await player.frame(activeStep);
    const displayProjectile = active.checkpoint.state?.projectiles.find(
      ({ abilityId }) => abilityId === 'ordinary-flare',
    );
    expect(displayProjectile).toBeDefined();
    for (const step of [manifest.lastVerifiedStep!, activeStep, 0, activeStep])
      await expect(player.frame(step)).resolves.toBeDefined();
    const model = buildSceneModel(context, active.checkpoint),
      projectile = model.projectiles.find(({ id }) => id === displayProjectile!.id);
    expect(projectile).toBeDefined();
    expect(
      renderToStaticMarkup(createElement(Scene2D, { model, overlays: NO_OVERLAYS })),
    ).toContain(projectile!.colour);
    expect(createElement(SceneEffects, { model }).props.model).toBe(model);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
