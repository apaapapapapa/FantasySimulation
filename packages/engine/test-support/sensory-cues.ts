import { combatManifest } from './fixtures.ts';
import { ManifestBuilder, sealRevision } from '../src/spatial/manifest-builder.ts';

export async function sensoryCueManifest(maxSteps = 20) {
  let manifest = await combatManifest(maxSteps, {
    ids: {
      ability: 'sk06-illusion',
      policy: 'sk06-policy',
      character: 'sk06-cognitive',
    },
    ability: {
      target: 'enemy',
      trigger: 'action',
      attack: { kind: 'hitscan', radiusMm: 0 },
      aimErrorMilliDegrees: 0,
      rangeMm: 200_000,
      castSteps: 0,
      recoverySteps: 1,
      cooldownSteps: 100,
      costs: { hp: 0, mp: 0, uses: 1 },
      effects: [
        {
          kind: 'sensory-cue',
          modality: 'visual',
          offsetMm: { x: 12_000, y: 0, z: 4_000 },
          deliverySteps: 2,
          durationSteps: 10,
          discoverySteps: 6,
          confidenceBps: 8000,
        },
      ],
    },
    character: { mentalEligibility: 'cognitive' },
  });
  const rules = manifest.revisions.find((revision) => revision.kind === 'ruleset')!;
  if (rules.kind !== 'ruleset') throw new Error('Missing rules');
  const replacement = await sealRevision('ruleset', 'sk06-rules', rules.revision, {
    ...rules.definition,
    experimental: { mechanics: ['mind-read'] },
  });
  manifest = await ManifestBuilder.relink(manifest, [{ from: rules, to: replacement }]);
  return structuredClone(manifest);
}
