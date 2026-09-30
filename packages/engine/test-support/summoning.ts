import { combatManifest } from './fixtures.ts';
import { ManifestBuilder, sealRevision } from '../src/spatial/manifest-builder.ts';

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
