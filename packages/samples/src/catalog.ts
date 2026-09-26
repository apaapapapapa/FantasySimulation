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
  function get(kind: DefinitionKind, id: string) {
    const r = catalog.find((r) => r.kind === kind && r.id === id);
    if (!r) throw new Error('Unknown catalog entry: ' + id);
    return r;
  }
  const scenario = get('scenario', scenarioId);
  let rules = template.revisions.find((r) => r.kind === 'ruleset')!;
  if (rulesId) {
    const selected = get('ruleset', rulesId);
    if (selected.kind !== 'ruleset') throw new Error('Expected rules');
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
    p.character = reference(get('character', id));
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
