import {
  abilityEffects,
  deepFreeze,
  type DeepReadonly,
  type Definition,
  type Effect,
  type Stage,
} from '@fantasy/domain/spatial/execution';
import type { AbilityRevision } from '../state.ts';

type PlanData = {
  source: DeepReadonly<Definition<'ability'>>;
  stages: readonly DeepReadonly<Stage>[];
  effects: readonly DeepReadonly<Effect>[];
};
export type AbilityPlan = PlanData &
  (
    | { kind: 'single' | 'startup'; reaction: null }
    | { kind: 'staged'; reaction: null }
    | {
        kind: 'reaction';
        reaction: DeepReadonly<NonNullable<Definition<'ability'>['reaction']>>;
      }
  );
export type PreparedAbility = AbilityRevision & { readonly execution: AbilityPlan };

/** Normalize only internal execution data; saved definitions and stage clocks remain unchanged. */
function compilePlan(source: DeepReadonly<Definition<'ability'>>): AbilityPlan {
  const data: PlanData = {
    source,
    stages: source.stages ?? [
      {
        id: 'primary',
        offsetSteps: 0,
        durationSteps: source.attack.kind === 'melee' ? source.attack.activeSteps : 1,
        attack: source.attack,
        effects: source.effects,
      },
    ],
    effects: abilityEffects(source),
  };
  if (source.reaction) return { ...data, kind: 'reaction', reaction: source.reaction };
  if (source.trigger === 'battle-start') return { ...data, kind: 'startup', reaction: null };
  if (source.trigger !== 'action') throw new Error('Reaction trigger has no execution response');
  if (data.stages.length === 0) throw new Error('Ability execution plan is empty');
  return { ...data, kind: source.stages ? 'staged' : 'single', reaction: null };
}

/** Prepared objects are isolated from the caller and are never serialized into the manifest. */
export function prepareAbility(input: AbilityRevision): PreparedAbility {
  const { kind, id, revision, schemaVersion, contentHash } = input;
  const definition = structuredClone(input.definition);
  return deepFreeze({
    kind,
    id,
    revision,
    schemaVersion,
    contentHash,
    definition,
    execution: compilePlan(definition),
  });
}

/** Low-level rule callers may pass a raw revision. Derived stage projections must not reuse a
 * plan belonging to the original definition. Normal prepared battles take the constant-time path.
 */
export function abilityPlan(ability: AbilityRevision): AbilityPlan {
  if (
    'execution' in ability &&
    ability.execution !== null &&
    typeof ability.execution === 'object' &&
    'source' in ability.execution &&
    ability.execution.source === ability.definition
  )
    return (ability as PreparedAbility).execution;
  return compilePlan(ability.definition);
}

export function authoredStages(ability: AbilityRevision): readonly DeepReadonly<Stage>[] {
  const plan = abilityPlan(ability);
  if (plan.kind !== 'staged') throw new Error('Expected an authored stage execution plan');
  return plan.stages;
}
