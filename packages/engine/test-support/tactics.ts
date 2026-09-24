import type { Definition, Manifest } from '@fantasy/domain/spatial';
import { catalogManifest } from '@fantasy/samples';
import { sealRevision, reference } from '../src/spatial/prepare.ts';
import { TACTICAL_AI } from '@fantasy/samples';

export async function withTacticalRules(
  manifest: Manifest,
  edit: Partial<NonNullable<Definition<'ruleset'>['ai']>> = {},
) {
  const rules = manifest.revisions.find(
    (r) => r.kind === 'ruleset' && r.id === manifest.ruleset.id,
  )!;
  if (rules.kind !== 'ruleset') throw new Error('Missing rules');
  const next = await sealRevision('ruleset', 'tactical-fixture', 1, {
    ...rules.definition,
    ai: { ...TACTICAL_AI, ...edit },
  });
  manifest.revisions = manifest.revisions.filter((r) => r !== rules);
  manifest.revisions.push(next);
  manifest.ruleset = reference(next);
  return manifest;
}
export async function tacticalManifest(scenario = 'pillars-surveyed-v1', steps = 1200, seed = 42) {
  return withTacticalRules(await catalogManifest('swordsman', 'swordsman', scenario, steps, seed));
}
