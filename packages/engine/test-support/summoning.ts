import { combatManifest } from './fixtures.ts';
import { ManifestBuilder, sealRevision } from '../src/spatial/manifest-builder.ts';
import { reference } from '../src/spatial/prepare.ts';
import { stopManifest } from './time-stop.ts';

export async function summoningManifest(maxSteps = 40) {
  let manifest = await combatManifest(maxSteps, {
    ids: { ability: 'sk07-rat-dan1', policy: 'sk07-policy', character: 'sk07-summoner' },
    ability: {
      name: 'Scout rat',
      originalText: 'Create one bounded scout rat dependent.',
      trigger: 'action',
      target: 'self',
      condition: { kind: 'always' },
      costs: { hp: 0, mp: 2, uses: 1 },
      castSteps: 0,
      recoverySteps: 1,
      cooldownSteps: 100,
      movementWhileCasting: 'allow',
      rangeMm: 0,
      aimErrorMilliDegrees: 0,
      attack: { kind: 'direct' },
      effects: [],
      summon: {
        profile: 'scout-rat-v1',
        body: {
          radiusMm: 180,
          heightMm: 360,
          eyeOffset: { x: 0, y: 100, z: 0 },
          muzzleOffset: { x: 0, y: 80, z: 120 },
          aimOffset: { x: 0, y: 80, z: 0 },
        },
        hp: 80,
        spawnOffsetMm: { x: 800, y: -720, z: 500 },
        lifetimeSteps: 30,
        upkeep: { mp: 1, everySteps: 10 },
        commandCostMp: 1,
        actionEverySteps: 5,
        damage: { amount: 8, drainBps: 5000 },
      },
    },
    character: {
      perception: { rangeMm: 50_000, fovMilliDegrees: 360_000, reactionSteps: 1, memorySteps: 250 },
    },
  });
  const rules = manifest.revisions.find((revision) => revision.kind === 'ruleset')!;
  if (rules.kind !== 'ruleset') throw new Error('Missing rules');
  const replacement = await sealRevision('ruleset', 'sk07-rules', rules.revision, {
    ...rules.definition,
  });
  manifest = await ManifestBuilder.relink(manifest, [{ from: rules, to: replacement }]);
  return manifest;
}

/** One real owner clock stop over a previously-created rat dependent. */
export async function stoppedSummoningManifest(
  options: {
    duration?: number;
    steps?: number;
    stopCastSteps?: number;
  } = {},
) {
  const source = await summoningManifest();
  const summon = source.revisions.find(
    (revision) => revision.kind === 'ability' && revision.definition.summon,
  )!;
  let manifest = await stopManifest({
    duration: options.duration ?? 5,
    steps: options.steps ?? 60,
  });
  const stop = manifest.revisions.find(
    (revision) => revision.kind === 'ability' && revision.definition.timeStop,
  )!;
  if (stop.kind !== 'ability') throw new Error('Missing stop fixture');
  const delayedStop = await ManifestBuilder.create('ability', stop.id, stop.revision + 1, {
    ...stop.definition,
    castSteps: options.stopCastSteps ?? 4,
  });
  manifest = await ManifestBuilder.relink(manifest, [{ from: stop, to: delayedStop }]);
  const character = manifest.revisions.find(
    (revision) =>
      revision.kind === 'character' && revision.id === manifest.participants[1].character.id,
  )!;
  if (character.kind !== 'character' || summon.kind !== 'ability')
    throw new Error('Missing stopped summon fixture');
  const policy = manifest.revisions.find(
    (revision) => revision.kind === 'policy' && revision.id === character.definition.policy.id,
  )!;
  if (policy.kind !== 'policy') throw new Error('Missing target policy');
  const ownPolicy = await ManifestBuilder.create('policy', 'stopped-summon-policy', 1, {
    ...policy.definition,
    priorities: [
      { abilityId: summon.id, when: { kind: 'always' } },
      ...policy.definition.priorities,
    ],
  });
  const actor = await ManifestBuilder.create('character', 'stopped-summon-owner', 1, {
    ...character.definition,
    abilities: [reference(summon), ...character.definition.abilities],
    policy: reference(ownPolicy),
  });
  manifest = await ManifestBuilder.relink(
    { ...manifest, revisions: [...manifest.revisions, summon, ownPolicy] },
    [{ from: character, to: actor }],
  );
  return manifest;
}
