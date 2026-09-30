import type { ResolvedActor, PreparedBattle } from './state.ts';
export type { ResolvedActor, PreparedBattle } from './state.ts';
import {
  DEFAULT_FORCED_SPEED_CAP_MM_PER_SECOND,
  canonicalJson,
  characterLoadout,
  CURRENT_SKILL_RESOLVER_VERSION,
  validateAbilityLoadout,
  validatePolicyAbilities,
  revisionHash,
  revisionIndex,
  resolveClosure,
  contentHash,
  deepFreeze,
  actorSeed,
  ManifestSchema,
  StoredManifestSchema,
  parseJson,
  compareIds,
  type Manifest,
  type Revision,
} from '@fantasy/domain/spatial/execution';
import implementation from './implementation.json' with { type: 'json' };
import profile from './profile.json' with { type: 'json' };
import {
  EngineInputError,
  executionEligibility,
  requireExecutable,
  requireExecutableRules,
} from './execution-policy.ts';
export { revisionHash, revisionReference as reference } from '@fantasy/domain/spatial/execution';
import { statusKnowledge } from './rules/status.ts';
import { prepareAbility, abilityPlan } from './rules/ability-plan.ts';
import { requireMechanics } from './mechanic-policy.ts';

export { implementation, profile };

/** One canonical ordering per prepared actor; ID ordering remains separate for startup and records. */
export function decisionAbilityOrder(
  abilities: ResolvedActor['abilities'],
): ResolvedActor['decisionAbilities'] {
  return abilities
    .map((revision) => ({ revision, key: canonicalJson(revision.definition) }))
    .sort((a, b) => compareIds(a.key, b.key) || compareIds(a.revision.id, b.revision.id))
    .map(({ revision }) => revision);
}
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
  for (const participant of manifest.participants) {
    const receipt = participant.skillLoadout;
    if (!receipt) continue;
    if (receipt.resolverVersion !== CURRENT_SKILL_RESOLVER_VERSION)
      throw new EngineInputError(
        'revision-content',
        `Unsupported skill resolver: ${receipt.resolverVersion}`,
      );
    if (canonicalJson(receipt.character) !== canonicalJson(participant.character))
      throw new EngineInputError('revision-content', 'Skill loadout character mismatch');
    const digest = await contentHash(
      JSON.parse(
        canonicalJson({
          resolverVersion: receipt.resolverVersion,
          catalog: receipt.catalog,
          resolvedNodeIds: receipt.resolvedNodeIds,
          nodeResolutions: receipt.nodeResolutions,
        }),
      ),
    );
    if (digest !== receipt.resolutionDigest)
      throw new EngineInputError('revision-content', 'Skill loadout resolution digest mismatch');
  }
  function actor(participant: Manifest['participants'][number]): ResolvedActor {
    if (participant.rngSeed !== actorSeed(manifest.seed, participant.rngStream))
      throw new EngineInputError('actor-seed', 'Actor seed derivation mismatch');
    const loadout = characterLoadout(participant.character, get);
    validatePolicyAbilities(loadout);
    const { character, equipment } = loadout,
      baseAbilities = new Map(loadout.abilities.map((ability) => [ability.id, ability])),
      grantedAbilities: Extract<Revision, { kind: 'ability' }>[] = [],
      augmentations: Array<{
        base: Extract<Revision, { kind: 'ability' }>;
        resolved: Extract<Revision, { kind: 'ability' }>;
      }> = [];
    for (const { resolution } of participant.skillLoadout?.nodeResolutions ?? [])
      for (const item of resolution) {
        if (item.kind === 'augment') {
          const base = get('ability', item.baseAbility),
            resolved = get('ability', item.resolvedAbility),
            equipped = baseAbilities.get(base.id);
          if (
            !equipped ||
            equipped.revision !== base.revision ||
            equipped.contentHash !== base.contentHash
          )
            throw new EngineInputError(
              'revision-content',
              `Augment base ability is not in the character loadout: ${base.id}`,
            );
          if (
            resolved.id !== base.id ||
            (resolved.revision === base.revision && resolved.contentHash === base.contentHash) ||
            resolved.definition.trigger !== base.definition.trigger
          )
            throw new EngineInputError(
              'revision-content',
              `Augment must preserve ability identity and trigger: ${base.id}`,
            );
          augmentations.push({ base, resolved });
        } else {
          const ability = get('ability', item.ability);
          if (
            participant.skillLoadout?.schemaVersion === 2 &&
            item.kind === 'active-ability' &&
            ability.definition.trigger !== 'action'
          )
            throw new EngineInputError(
              'revision-content',
              `Active skill ability must use the action trigger: ${ability.id}`,
            );
          if (item.kind === 'passive-ability' && ability.definition.trigger === 'action')
            throw new EngineInputError(
              'revision-content',
              `Passive skill ability cannot use the action trigger: ${ability.id}`,
            );
          grantedAbilities.push(ability);
        }
      }
    const direct = new Map(character.abilities.map((ability) => [ability.id, ability]));
    for (const ability of grantedAbilities) {
      const previous = direct.get(ability.id);
      if (
        previous &&
        (previous.revision !== ability.revision || previous.contentHash !== ability.contentHash)
      )
        throw new EngineInputError(
          'revision-content',
          `Skill ability conflicts with character ability: ${ability.id}`,
        );
      direct.set(ability.id, {
        id: ability.id,
        revision: ability.revision,
        contentHash: ability.contentHash,
      });
    }
    if (direct.size > 32)
      throw new EngineInputError('revision-content', 'Skill loadout exceeds direct ability limit');
    const abilityById = new Map(baseAbilities);
    for (const ability of grantedAbilities) {
      const previous = abilityById.get(ability.id);
      if (
        previous &&
        (previous.revision !== ability.revision || previous.contentHash !== ability.contentHash)
      )
        throw new EngineInputError(
          'revision-content',
          `Skill ability conflicts with equipped ability: ${ability.id}`,
        );
      abilityById.set(ability.id, ability);
    }
    for (const { resolved } of augmentations) abilityById.set(resolved.id, resolved);
    validateAbilityLoadout([...abilityById.values()]);
    const abilities = [...abilityById.values()].map(prepareAbility),
      skillActionIds = grantedAbilities
        .filter((ability) => ability.definition.trigger === 'action')
        .map((ability) => ability.id)
        .sort(compareIds),
      priorities = [...loadout.policy.priorities];
    for (const abilityId of skillActionIds)
      if (!priorities.some((priority) => priority.abilityId === abilityId))
        priorities.push({ when: { kind: 'always' }, abilityId });
    if (priorities.length > 32)
      throw new EngineInputError('revision-content', 'Skill loadout exceeds policy priority limit');
    const policy = { ...loadout.policy, priorities };
    const knownStatuses = statusKnowledge(
      abilities.flatMap((a) =>
        abilityPlan(a).effects.flatMap((e) =>
          e.kind === 'apply-status' ? [get('status', e.status)] : [],
        ),
      ),
      manifest.revisions.filter((r) => r.kind === 'status'),
    );
    return {
      participant,
      character,
      decisionAbilities: decisionAbilityOrder(abilities),
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
  requireExecutableRules(rules);
  requireMechanics(get('ruleset', manifest.ruleset), manifest.revisions);
  for (const recipient of manifest.revisions.some(
    (revision) => revision.kind === 'status' && revision.definition.immortality,
  )
    ? actors
    : []) {
    const grants = actors.flatMap((source) =>
      source.abilities
        .filter((ability) => (ability.definition.target === 'self') === (source === recipient))
        .flatMap((ability) =>
          abilityPlan(ability).effects.flatMap((effect) =>
            effect.kind === 'apply-status' ? [get('status', effect.status)] : [],
          ),
        ),
    );
    const immortal = statusKnowledge(
      grants,
      manifest.revisions.filter((revision) => revision.kind === 'status'),
    ).filter((status) => status.definition.immortality);
    if (
      new Set(immortal.map((status) => `${status.id}:${status.revision}:${status.contentHash}`))
        .size > 1
    )
      throw new EngineInputError(
        'unsupported-mechanic',
        `Conflicting immortality revisions for ${recipient.participant.actorId}`,
        {
          mechanic: 'immortality',
          owner: immortal[0]!,
        },
      );
  }
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
    scenario: { ...scenario, terrainKnowledge: scenario.terrainKnowledge ?? 'observed' },
    rules: {
      ...rules,
      forcedSpeedCapMmPerSecond:
        rules.forcedSpeedCapMmPerSecond ?? DEFAULT_FORCED_SPEED_CAP_MM_PER_SECOND,
    },
    statuses: manifest.revisions.filter((r) => r.kind === 'status'),
  });
}
