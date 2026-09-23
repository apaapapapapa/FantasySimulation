import type { ActorState, AbilityRevision } from './combat-state.ts';
import type { ResourceBudget } from './resources.ts';
import { flightRate } from './locomotion.ts';
import { declarationCost } from './attacks.ts';

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
    (definition.castSteps > 0 && definition.movementWhileCasting === 'stop')
  )
    return { ok: false as const, reason: 'incompatible-motion' };
  const movement = actor.motion.actor.character.movement.locomotion;
  const flight = actor.intent.flight ? Math.ceil(flightRate(actor.statuses, step) * 0.02) : 0;
  const jump = actor.intent.jump && actor.motion.grounded ? (movement?.jumpStamina ?? 0) : 0;
  const result = budget.reserve('pair-admission', [
    { ...declarationCost(definition), uses: { id: ability.id, limit: definition.costs.uses } },
    { stamina: flight + jump + (movement?.dodgeStamina ?? 0) },
  ]);
  if (result.ok) budget.cancel('pair-admission');
  return result;
}
