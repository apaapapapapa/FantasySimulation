import type { ActorState } from '../state.ts';
import type { Journal } from './journal.ts';
import { resourceLimits, staminaExhausted, updateResources } from './resources.ts';

/** End-of-interval recovery follows settled costs/effects, including the final interval.
 * A state applied for the next boundary cannot alter the elapsed interval's recovery.
 * G-03 can pass its aggregated add/multiply adjustments to this shared update.
 */
export function recoverActorResources(
  actor: ActorState,
  elapsedMs: number,
  boundaryStep: number,
  journal: Journal,
  adjustment: { addPerSecond?: number; multiplierBps?: number } = {},
) {
  const definition = actor.body.motion.actor.character.stamina;
  if (!definition || !actor.vitals.staminaClock) return;
  const before = { ...actor.vitals.resources };
  const exhausted = staminaExhausted(before, definition, actor.vitals.staminaClock.exhausted);
  const updated = updateResources(before, resourceLimits(actor.body.motion.actor.character), [], {
    ...adjustment,
    elapsedMs,
    perSecond: definition.recoveryPerSecond,
    remainder: actor.vitals.staminaClock.remainder,
  });
  actor.vitals.resources = updated.resources;
  actor.vitals.staminaClock = {
    remainder: updated.remainder,
    exhausted: staminaExhausted(updated.resources, definition, exhausted),
  };
  if (updated.actual.stamina)
    journal.emit({
      kind: 'resource',
      step: boundaryStep,
      phase: 'resolution',
      actorId: actor.body.motion.actor.participant.actorId,
      ruleId: 'resource.stamina-recovery',
      before,
      after: { ...updated.resources },
      amount: updated.actual.stamina,
    });
}
