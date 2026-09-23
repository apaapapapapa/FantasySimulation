import type { ActorState, AbilityRevision } from './combat-state.ts';
import type { ResourceBudget, ResourceRequest } from './resources.ts';
import { flightRate } from './locomotion.ts';
import { declarationCost } from './attacks.ts';
import { ownsStageMotion } from './stage-motion.ts';

/** Keep the attempted choice in cognition, but restore every input used by motion settlement. */
export function rejectPair(actor: ActorState, previous: Pick<ActorState, 'intent' | 'decision'>) {
  const { gait: _, ...decision } = actor.decision;
  actor.decision = {
    ...decision,
    abilityId: null,
    dodge: false,
    ...(previous.decision.gait ? { gait: previous.decision.gait } : {}),
  };
  actor.intent = {
    ...previous.intent,
    canMove: actor.intent.canMove,
    speedBps: actor.intent.speedBps,
    flight: actor.intent.flight,
  };
}

/** Validate the entire new pair before either slot mutates resources, uses or clocks.
 * The guard is released immediately; synchronous declaration then motion reserve
 * against this same budget, without an intervening update or another consumer.
 */
export function admitPair(
  actor: ActorState,
  ability: AbilityRevision,
  budget: ResourceBudget,
  step: number,
) {
  const definition = ability.definition;
  if (
    !actor.intent.canMove ||
    ownsStageMotion(actor.action, step) ||
    (definition.castSteps === 0 && !!definition.stages?.[0]?.selfMotion) ||
    (definition.castSteps > 0 && definition.movementWhileCasting === 'stop')
  )
    return { ok: false as const, reason: 'incompatible-motion' };
  return admitMotionCost(
    actor,
    budget,
    step,
    'pair-admission',
    [{ ...declarationCost(definition), uses: { id: ability.id, limit: definition.costs.uses } }],
    true,
  );
}

/** A due stage uses the same interval admission as a newly declared action.
 * Keep maintainable flight and selected bursts affordable before paying either slot.
 * The guard holds nothing across calls; the coordinator consumes this budget synchronously.
 */
export function admitMotionCost(
  actor: ActorState,
  budget: ResourceBudget,
  step: number,
  key: string,
  requests: readonly ResourceRequest[],
  dodge: boolean,
  authoredJump = false,
) {
  const movement = actor.motion.actor.character.movement.locomotion;
  const flight = actor.intent.flight ? Math.ceil(flightRate(actor.statuses, step) * 0.02) : 0;
  const jump =
    actor.intent.canMove && (authoredJump || actor.intent.jump) && actor.motion.grounded
      ? (movement?.jumpStamina ?? 0)
      : 0;
  const result = budget.reserve(key, [
    ...requests,
    {
      stamina: flight + jump + (dodge && actor.intent.canMove ? (movement?.dodgeStamina ?? 0) : 0),
    },
  ]);
  if (result.ok) budget.cancel(key);
  return result;
}
