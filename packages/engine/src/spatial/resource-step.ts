import type { ActorState } from './combat-state.ts';
import type { Journal } from './journal.ts';
import { resourceLimits, staminaExhausted, updateResources } from './resources.ts';

/** End-of-interval recovery follows settled costs/effects, including the final interval.
 * A state applied for the next boundary cannot alter the elapsed interval's recovery.
 * G-03 can pass its aggregated add/multiply adjustments to this shared update.
 */
export function recoverActorResources(
  actor: ActorState,
  elapsedMs: number,
  step: number,
  journal: Journal,
  adjustment: { addPerSecond?: number; multiplierBps?: number } = {},
) {
  const definition = actor.motion.actor.character.stamina;
  if (!definition || !actor.staminaClock) return;
  const before = { ...actor.resources };
  const exhausted = staminaExhausted(before, definition, actor.staminaClock.exhausted);
  const updated = updateResources(before, resourceLimits(actor.motion.actor.character), [], {
    ...adjustment,
    elapsedMs,
    perSecond: definition.recoveryPerSecond,
    remainder: actor.staminaClock.remainder,
  });
  actor.resources = updated.resources;
  actor.staminaClock = {
    remainder: updated.remainder,
    exhausted: staminaExhausted(updated.resources, definition, exhausted),
  };
  if (updated.actual.stamina)
    journal.emit({
      kind: 'resource',
      step,
      phase: 'resolution',
      subtimeMicros: 1_000_000,
      actorId: actor.motion.actor.participant.actorId,
      ruleId: 'resource.stamina-recovery',
      before,
      after: { ...updated.resources },
      amount: updated.actual.stamina,
    });
}
