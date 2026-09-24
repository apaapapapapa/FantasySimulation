import { contentHash } from './canonical.ts';
import {
  abilityEffects,
  type DefinitionKind,
  type Revision,
  type RevisionRef,
} from './contracts.ts';
import { statusTransformationRefs } from './status-references.ts';

export type RevisionDependency = { kind: DefinitionKind; ref: RevisionRef };
export type RevisionLookup = (kind: DefinitionKind, ref: RevisionRef) => Revision | undefined;
export type RevisionGraphCode =
  | 'missing-revision'
  | 'duplicate-revision'
  | 'revision-limit'
  | 'revision-cycle'
  | 'duplicate-ability'
  | 'missing-policy-ability';
export class RevisionGraphError extends Error {
  readonly code: RevisionGraphCode;
  constructor(code: RevisionGraphCode, message: string) {
    super(message);
    this.name = 'RevisionGraphError';
    this.code = code;
  }
}
export const revisionKey = (revision: Pick<Revision, 'kind' | 'id' | 'revision'>) =>
  `${revision.kind}:${revision.id}:${revision.revision}`;
export const revisionReference = ({ id, revision, contentHash }: Revision): RevisionRef => ({
  id,
  revision,
  contentHash,
});
export const revisionHash = (revision: Pick<Revision, 'kind' | 'schemaVersion' | 'definition'>) =>
  contentHash({
    kind: revision.kind,
    schemaVersion: revision.schemaVersion,
    definition: revision.definition,
  });

/** Canonical edge order is also the catalog's historical discovery order. */
export function revisionDependencies(revision: Revision): RevisionDependency[] {
  switch (revision.kind) {
    case 'character':
      return [
        { kind: 'policy', ref: revision.definition.policy },
        ...revision.definition.abilities.map((ref) => ({ kind: 'ability' as const, ref })),
        ...revision.definition.equipment.map((ref) => ({ kind: 'equipment' as const, ref })),
      ];
    case 'equipment':
      return revision.definition.abilities.map((ref) => ({ kind: 'ability', ref }));
    case 'ability':
      return abilityEffects(revision.definition).flatMap((effect) =>
        effect.kind === 'apply-status' ? [{ kind: 'status' as const, ref: effect.status }] : [],
      );
    case 'status':
      return statusTransformationRefs(revision.definition).map((ref) => ({ kind: 'status', ref }));
    case 'policy':
    case 'scenario':
    case 'ruleset':
      return [];
    default: {
      const unreachable: never = revision;
      throw new Error(`Unknown revision: ${String(unreachable)}`);
    }
  }
}
export function requireRevision<K extends DefinitionKind>(
  lookup: RevisionLookup,
  kind: K,
  ref: RevisionRef,
): Extract<Revision, { kind: K }> {
  const value = lookup(kind, ref);
  if (
    !value ||
    value.kind !== kind ||
    value.id !== ref.id ||
    value.revision !== ref.revision ||
    value.contentHash !== ref.contentHash
  )
    throw new RevisionGraphError(
      'missing-revision',
      `Missing or mismatched ${kind} revision: ${ref.id}`,
    );
  return value as Extract<Revision, { kind: K }>;
}
export function revisionIndex(revisions: readonly Revision[]) {
  const index = new Map<string, Revision>();
  for (const revision of revisions) {
    const key = revisionKey(revision);
    if (index.has(key))
      throw new RevisionGraphError('duplicate-revision', `Duplicate revision identity: ${key}`);
    index.set(key, revision);
  }
  return <K extends DefinitionKind>(kind: K, ref: RevisionRef) =>
    requireRevision((kind, ref) => index.get(revisionKey({ kind, ...ref })), kind, ref);
}

/** One bounded traversal; every incoming reference is checked, including already visited nodes. */
export function resolveClosure(
  roots: readonly Revision[],
  lookup: RevisionLookup,
  limit = 256,
  options: {
    dependencies?: (revision: Revision) => RevisionDependency[];
    order?: 'discovery' | 'dependencies-first';
  } = {},
): Revision[] {
  const found = new Map<string, Revision>(),
    active = new Set<string>(),
    ordered: Revision[] = [];
  const visit = (revision: Revision) => {
    const key = revisionKey(revision),
      previous = found.get(key);
    if (previous && previous.contentHash !== revision.contentHash)
      throw new RevisionGraphError('duplicate-revision', `Conflicting revision identity: ${key}`);
    if (options.order === 'dependencies-first' && active.has(key))
      throw new RevisionGraphError('revision-cycle', `Cannot reseal cyclic revisions: ${key}`);
    if (previous) return;
    if (found.size >= limit)
      throw new RevisionGraphError('revision-limit', `Revision closure exceeds ${limit} entries`);
    found.set(key, revision);
    active.add(key);
    for (const edge of (options.dependencies ?? revisionDependencies)(revision))
      visit(requireRevision(lookup, edge.kind, edge.ref));
    active.delete(key);
    ordered.push(revision);
  };
  roots.forEach(visit);
  return options.order === 'dependencies-first' ? ordered : [...found.values()];
}

export function characterLoadout(ref: RevisionRef, lookup: RevisionLookup) {
  const get = <K extends DefinitionKind>(kind: K, ref: RevisionRef) =>
    requireRevision(lookup, kind, ref);
  const character = get('character', ref).definition;
  const equipment = character.equipment.map((ref) => get('equipment', ref).definition);
  const abilities = [...character.abilities, ...equipment.flatMap((item) => item.abilities)].map(
    (ref) => get('ability', ref),
  );
  const ids = new Set<string>();
  for (const ability of abilities) {
    if (ids.has(ability.id))
      throw new RevisionGraphError('duplicate-ability', `Duplicate actor ability: ${ability.id}`);
    ids.add(ability.id);
  }
  return { character, equipment, abilities, policy: get('policy', character.policy).definition };
}
export function validatePolicyAbilities(loadout: ReturnType<typeof characterLoadout>) {
  const ids = new Set(loadout.abilities.map((ability) => ability.id));
  for (const priority of loadout.policy.priorities)
    if (!ids.has(priority.abilityId))
      throw new RevisionGraphError(
        'missing-policy-ability',
        `Policy references unavailable ability: ${priority.abilityId}`,
      );
}
