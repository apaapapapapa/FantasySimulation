import { combatManifest, observerVisualAbility } from './fixtures.ts';
import { ManifestBuilder, sealRevision } from '../src/spatial/manifest-builder.ts';

export async function environmentalHologramManifest(maxSteps = 20) {
  let manifest = await combatManifest(maxSteps, {
    ids: {
      ability: 'sk07-hologram',
      policy: 'sk07-policy',
      character: 'sk07-sensor-actor',
    },
    ability: observerVisualAbility({
      kind: 'environmental-hologram',
      modality: 'visual',
      offsetMm: { x: 12_000, y: 0, z: 4_000 },
      observationSteps: 2,
      invalidationSteps: 7,
      durationSteps: 10,
    }),
  });
  const rules = manifest.revisions.find((revision) => revision.kind === 'ruleset')!;
  if (rules.kind !== 'ruleset') throw new Error('Missing rules');
  const replacement = await sealRevision('ruleset', 'sk07-rules', rules.revision, {
    ...rules.definition,
    experimental: { mechanics: ['visibility'] },
  });
  manifest = await ManifestBuilder.relink(manifest, [{ from: rules, to: replacement }]);
  return structuredClone(manifest);
}
