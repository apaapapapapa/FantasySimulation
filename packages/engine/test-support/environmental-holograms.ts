import { combatManifest, observerVisualAbility } from './fixtures.ts';
import { ManifestBuilder, sealRevision } from '../src/spatial/manifest-builder.ts';
import { reference } from '../src/spatial/prepare.ts';
import { summoningManifest } from './summoning.ts';

export async function environmentalHologramManifest(maxSteps = 20, durationSteps = 10) {
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
      durationSteps,
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

/** A schema-9 input with both capabilities, while keeping hologram first in policy order. */
export async function environmentalHologramSummoningManifest(maxSteps = 40, durationSteps = 300) {
  let manifest = await environmentalHologramManifest(maxSteps, durationSteps);
  const summonSource = await summoningManifest(maxSteps);
  const summon = summonSource.revisions.find(
    (revision) => revision.kind === 'ability' && revision.definition.summon,
  );
  const character = manifest.revisions.find(
    (revision) =>
      revision.kind === 'character' && revision.id === manifest.participants[0]?.character.id,
  );
  if (!summon || summon.kind !== 'ability' || !character || character.kind !== 'character') {
    throw new Error('Missing hologram or summon fixture');
  }
  const combined = await sealRevision('character', character.id, character.revision, {
    ...character.definition,
    abilities: [...character.definition.abilities, reference(summon)],
  });
  manifest = await ManifestBuilder.relink(
    { ...manifest, revisions: [...manifest.revisions, summon] },
    [{ from: character, to: combined }],
  );
  return structuredClone(manifest);
}
