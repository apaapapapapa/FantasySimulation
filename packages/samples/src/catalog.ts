import {
  revisionIndex,
  resolveClosure,
  actorSeed,
  parseJson,
  RevisionSchema,
  type DefinitionKind,
  type Manifest,
  type Revision,
  type RevisionRef,
} from '@fantasy/domain/spatial';
import { reference, sealRevision } from '@fantasy/engine/spatial';
import catalog from '../../../data/spatial/catalog.json' with { type: 'json' };
import { sampleManifest } from './sample.ts';
import { leagueStarts } from './league-terrain.ts';

/** Fresh validated copies of the generated catalog; authoring never imports this output. */
export async function sampleCatalog(): Promise<Revision[]> {
  return parseJson(RevisionSchema.array(), catalog);
}

/** ID-only authoring selectors fail closed once an immutable ID has multiple revisions. */
export function uniqueCatalogRevision<K extends DefinitionKind>(
  revisions: readonly Revision[],
  kind: K,
  id: string,
): Extract<Revision, { kind: K }> {
  const matches = revisions.filter(
    (revision): revision is Extract<Revision, { kind: K }> =>
      revision.kind === kind && revision.id === id,
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? `Ambiguous catalog entry: ${kind}:${id}`
        : `Unknown catalog entry: ${kind}:${id}`,
    );
  return matches[0]!;
}

/** Include only reachable revisions, so unrelated catalog additions cannot change a battle hash. */
export function revisionClosure(
  revisions: readonly Revision[],
  roots: readonly { kind: DefinitionKind; ref: RevisionRef }[],
): Revision[] {
  const get = revisionIndex(revisions);
  return structuredClone(
    resolveClosure(
      roots.map(({ kind, ref }) => get(kind, ref)),
      get,
    ),
  );
}
export async function catalogManifest(
  left = 'swordsman',
  right = 'sky-mage',
  scenarioId = 'pillars-surveyed-v1',
  maxSteps = 6000,
  seed = 42,
  rulesId?: string,
): Promise<Manifest> {
  const catalog = await sampleCatalog(),
    template = await sampleManifest(maxSteps);
  const scenario = uniqueCatalogRevision(catalog, 'scenario', scenarioId);
  let rules = template.revisions.find((r) => r.kind === 'ruleset')!;
  if (rulesId) {
    const selected = uniqueCatalogRevision(catalog, 'ruleset', rulesId);
    rules = await sealRevision('ruleset', rulesId, selected.revision, {
      ...selected.definition,
      maxSteps,
    });
    template.ruleset = reference(rules);
  }
  const revisions = catalog.map((r) => (r.kind === 'ruleset' && r.id === rules.id ? rules : r));
  template.seed = seed;
  for (const [i, id] of [left, right].entries()) {
    const p = template.participants[i]!;
    p.character = reference(uniqueCatalogRevision(catalog, 'character', id));
    p.rngSeed = actorSeed(seed, p.rngStream);
    p.position.x = i === 0 ? -6000 : 6000;
    if (scenarioId === 'aerial-surveyed-v1') p.position.y = leagueStarts(scenarioId)[i]!.position.y;
  }
  template.scenario = reference(scenario);
  template.revisions = revisionClosure(revisions, [
    ...template.participants.map((p) => ({ kind: 'character' as const, ref: p.character })),
    { kind: 'ruleset', ref: template.ruleset },
    { kind: 'scenario', ref: template.scenario },
  ]);
  return template;
}
