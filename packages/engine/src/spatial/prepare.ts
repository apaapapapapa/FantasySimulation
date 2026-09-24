import {
  abilityEffects,
  characterLoadout,
  validatePolicyAbilities,
  revisionHash,
  revisionIndex,
  resolveClosure,
  contentHash,
  deepFreeze,
  type DeepReadonly,
  actorSeed,
  ManifestSchema,
  StoredManifestSchema,
  parseJson,
  compareIds,
  type Definition,
  type Manifest,
  type Revision,
} from '@fantasy/domain/spatial/execution';
import implementation from './implementation.json' with { type: 'json' };
import profile from './profile.json' with { type: 'json' };
import {
  EngineInputError,
  executionEligibility,
  requireExecutable,
  rulesExecutionEligibility,
} from './execution-policy.ts';
export { revisionHash, revisionReference as reference } from '@fantasy/domain/spatial/execution';

import { statusKnowledge } from './status.ts';

export { implementation, profile };
export type ResolvedActor = DeepReadonly<{
  participant: Manifest['participants'][number];
  character: Definition<'character'>;
  abilities: Extract<Revision, { kind: 'ability' }>[];
  equipment: Definition<'equipment'>[];
  policy: Definition<'policy'>;
  knownStatuses?: Extract<Revision, { kind: 'status' }>[];
}>;
export type PreparedBattle = DeepReadonly<{
  manifest: Manifest;
  simulationHash: string;
  rules: Definition<'ruleset'>;
  scenario: Definition<'scenario'>;
  actors: [ResolvedActor, ResolvedActor];
  statuses: Extract<Revision, { kind: 'status' }>[];
}>;
export async function prepareBattle(input: unknown): Promise<PreparedBattle> {
  requireExecutable(executionEligibility(parseJson(StoredManifestSchema, input)));
  const manifest = parseJson(ManifestSchema, input);
  if (
    manifest.physicsProfileHash !== (await contentHash(profile)) ||
    manifest.physicsProfileHash !== (await contentHash(manifest.physicsProfile))
  )
    throw new EngineInputError(
      'unsupported-identity',
      'Unsupported engine/physics implementation identity',
    );
  for (const revision of manifest.revisions)
    if (revision.contentHash !== (await revisionHash(revision)))
      throw new EngineInputError(
        'revision-content',
        `Revision content hash mismatch: ${revision.id}`,
      );
  const get = revisionIndex(manifest.revisions);
  resolveClosure(manifest.revisions, get);
  function actor(participant: Manifest['participants'][number]): ResolvedActor {
    if (participant.rngSeed !== actorSeed(manifest.seed, participant.rngStream))
      throw new EngineInputError('actor-seed', 'Actor seed derivation mismatch');
    const loadout = characterLoadout(participant.character, get);
    validatePolicyAbilities(loadout);
    const { character, equipment, abilities, policy } = loadout;
    const knownStatuses = statusKnowledge(
      abilities.flatMap((a) =>
        abilityEffects(a.definition).flatMap((e) =>
          e.kind === 'apply-status' ? [get('status', e.status)] : [],
        ),
      ),
      manifest.revisions.filter((r) => r.kind === 'status'),
    );
    return {
      participant,
      character,
      abilities: abilities.sort((a, b) => compareIds(a.id, b.id)),
      equipment,
      policy,
      ...(knownStatuses.length && { knownStatuses }),
    };
  }
  const actors: PreparedBattle['actors'] = [
    actor(manifest.participants[0]),
    actor(manifest.participants[1]),
  ];
  const scenario = get('scenario', manifest.scenario).definition;
  const rules = get('ruleset', manifest.ruleset).definition;
  requireExecutable(rulesExecutionEligibility(rules));
  for (const { participant, character } of actors) {
    for (const axis of ['x', 'y', 'z'] as const) {
      const extent = axis === 'y' ? character.body.heightMm / 2 : character.body.radiusMm;
      if (
        participant.position[axis] - extent < scenario.bounds.min[axis] ||
        participant.position[axis] + extent > scenario.bounds.max[axis]
      )
        throw new EngineInputError('spawn-bounds', 'Spawn body exceeds arena bounds');
    }
  }
  // Revision enumeration is normalized. Saved arrays retain identity; policy conditions are evaluated as a set.
  manifest.revisions.sort((a, b) =>
    compareIds(`${a.kind}:${a.id}:${a.revision}`, `${b.kind}:${b.id}:${b.revision}`),
  );
  return deepFreeze({
    manifest,
    simulationHash: await contentHash(manifest),
    actors,
    scenario,
    rules,
    statuses: manifest.revisions.filter((r) => r.kind === 'status'),
  });
}
