import {
  contentHash,
  actorSeed,
  ManifestSchema,
  parseJson,
  RevisionSchema,
  compareIds,
  type Definition,
  type DefinitionKind,
  type Manifest,
  type Revision,
  type RevisionRef,
} from '@fantasy/domain/spatial';
import implementation from './implementation.json' with { type: 'json' };
import profile from './profile.json' with { type: 'json' };

export { implementation, profile };
export type ResolvedActor = {
  participant: Manifest['participants'][number];
  character: Definition<'character'>;
  abilities: Extract<Revision, { kind: 'ability' }>[];
  equipment: Definition<'equipment'>[];
  policy: Definition<'policy'>;
};
export type PreparedBattle = {
  manifest: Manifest;
  simulationHash: string;
  rules: Definition<'ruleset'>;
  scenario: Definition<'scenario'>;
  actors: [ResolvedActor, ResolvedActor];
  statuses: Extract<Revision, { kind: 'status' }>[];
};
export const revisionHash = (revision: Pick<Revision, 'kind' | 'schemaVersion' | 'definition'>) =>
  contentHash({
    kind: revision.kind,
    schemaVersion: revision.schemaVersion,
    definition: revision.definition,
  });
export async function sealRevision<K extends DefinitionKind>(
  kind: K,
  id: string,
  revision: number,
  definition: Definition<K>,
): Promise<Extract<Revision, { kind: K }>> {
  const contentHash = await revisionHash({ kind, schemaVersion: 1, definition });
  return parseJson(RevisionSchema, {
    kind,
    id,
    revision,
    schemaVersion: 1,
    contentHash,
    definition,
  }) as Extract<Revision, { kind: K }>;
}
export const reference = (revision: Revision): RevisionRef => ({
  id: revision.id,
  revision: revision.revision,
  contentHash: revision.contentHash,
});

export async function prepareBattle(input: unknown): Promise<PreparedBattle> {
  const manifest = parseJson(ManifestSchema, input);
  if (
    manifest.implementationDigest !== implementation.digest ||
    manifest.wasmHash !== implementation.wasm ||
    manifest.angleTableHash !== implementation.table ||
    manifest.physicsProfileHash !== (await contentHash(profile)) ||
    manifest.physicsProfileHash !== (await contentHash(manifest.physicsProfile))
  )
    throw new Error('Unsupported engine/physics implementation identity');
  for (const revision of manifest.revisions)
    if (revision.contentHash !== (await revisionHash(revision)))
      throw new Error(`Revision content hash mismatch: ${revision.id}`);
  function get<K extends DefinitionKind>(
    kind: K,
    ref: RevisionRef,
  ): Extract<Revision, { kind: K }> {
    const value = manifest.revisions.find(
      (r) => r.kind === kind && r.id === ref.id && r.revision === ref.revision,
    );
    if (!value || value.contentHash !== ref.contentHash)
      throw new Error(`Missing or mismatched ${kind} revision: ${ref.id}`);
    return value as Extract<Revision, { kind: K }>;
  }
  function actor(participant: Manifest['participants'][number]): ResolvedActor {
    if (participant.rngSeed !== actorSeed(manifest.seed, participant.rngStream))
      throw new Error('Actor seed derivation mismatch');
    const character = get('character', participant.character).definition;
    const equipment = character.equipment.map((ref) => get('equipment', ref).definition);
    const refs = [...character.abilities, ...equipment.flatMap((item) => item.abilities)];
    const abilities = refs.map((ref) => get('ability', ref));
    const ids = new Set<string>();
    for (const ability of abilities) {
      if (ids.has(ability.id)) throw new Error(`Duplicate actor ability: ${ability.id}`);
      ids.add(ability.id);
      for (const effect of ability.definition.effects)
        if (effect.kind === 'apply-status') get('status', effect.status);
    }
    const policy = get('policy', character.policy).definition;
    for (const priority of policy.priorities)
      if (!ids.has(priority.abilityId))
        throw new Error(`Policy references unavailable ability: ${priority.abilityId}`);
    return {
      participant,
      character,
      abilities: abilities.sort((a, b) => compareIds(a.id, b.id)),
      equipment,
      policy,
    };
  }
  for (const revision of manifest.revisions) {
    switch (revision.kind) {
      case 'character':
        get('policy', revision.definition.policy);
        for (const ref of revision.definition.abilities) get('ability', ref);
        for (const ref of revision.definition.equipment) get('equipment', ref);
        break;
      case 'equipment':
        for (const ref of revision.definition.abilities) get('ability', ref);
        break;
      case 'ability':
        for (const effect of revision.definition.effects)
          if (effect.kind === 'apply-status') get('status', effect.status);
        break;
      case 'policy':
      case 'scenario':
      case 'ruleset':
      case 'status':
        break;
      default: {
        const never: never = revision;
        throw new Error(`Unknown revision: ${String(never)}`);
      }
    }
  }
  const actors: PreparedBattle['actors'] = [
    actor(manifest.participants[0]),
    actor(manifest.participants[1]),
  ];
  const scenario = get('scenario', manifest.scenario).definition;
  for (const { participant, character } of actors) {
    for (const axis of ['x', 'y', 'z'] as const) {
      const extent = axis === 'y' ? character.body.heightMm / 2 : character.body.radiusMm;
      if (
        participant.position[axis] - extent < scenario.bounds.min[axis] ||
        participant.position[axis] + extent > scenario.bounds.max[axis]
      )
        throw new Error('Spawn body exceeds arena bounds');
    }
  }
  // Revisions are a set, while participants, policy priorities and effects have meaningful order.
  manifest.revisions.sort((a, b) =>
    compareIds(`${a.kind}:${a.id}:${a.revision}`, `${b.kind}:${b.id}:${b.revision}`),
  );
  return {
    manifest,
    simulationHash: await contentHash(manifest),
    actors,
    scenario,
    rules: get('ruleset', manifest.ruleset).definition,
    statuses: manifest.revisions.filter((r) => r.kind === 'status'),
  };
}
