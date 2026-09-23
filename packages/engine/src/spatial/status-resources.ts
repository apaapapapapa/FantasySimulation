import { compareIds } from '@fantasy/domain/spatial';
import type { ActorState } from './combat-state.ts';
import type { Journal } from './journal.ts';
import {
  resourceLimits,
  staminaExhausted,
  updateResources,
  type ResourceDelta,
} from './resources.ts';
import { statusAdjustmentTotals } from './status-modifiers.ts';
import type { StatusCohort, statusBoundary } from './status.ts';

export function statusRecoveryAdjustment(statuses: readonly StatusCohort[], step: number) {
  const { addition, multiplier } = statusAdjustmentTotals('staminaRecovery', statuses, step);
  return { addPerSecond: addition, multiplierBps: multiplier };
}

/** Boundary pulses share G-04 arithmetic, fractional carry and exhaustion hysteresis. */
export function applyStatusResourcePulses(
  actor: ActorState,
  pulses: ReturnType<typeof statusBoundary>['pulses'],
  step: number,
  journal: Journal,
) {
  const deltas: ResourceDelta[] = [],
    causes = { mp: new Set<string>(), stamina: new Set<string>() };
  for (const pulse of pulses) {
    if (pulse.effect.kind !== 'resource') continue;
    deltas.push({ [pulse.effect.resource]: pulse.effect.amount });
    for (const cause of pulse.causes) causes[pulse.effect.resource].add(cause);
  }
  if (!deltas.length) return;
  const before = { ...actor.resources },
    definition = actor.motion.actor.character.stamina;
  const exhausted = staminaExhausted(before, definition, actor.staminaClock?.exhausted);
  const update = updateResources(
    before,
    resourceLimits(actor.motion.actor.character),
    deltas,
    actor.staminaClock
      ? { elapsedMs: 0, perSecond: 0, remainder: actor.staminaClock.remainder }
      : undefined,
  );
  actor.resources = update.resources;
  if (actor.staminaClock)
    actor.staminaClock = {
      remainder: update.remainder,
      exhausted: staminaExhausted(update.resources, definition, exhausted),
    };
  for (const resource of ['mp', 'stamina'] as const) {
    const amount = update.actual[resource];
    if (!amount) continue;
    journal.emit({
      kind: 'resource',
      step,
      phase: 'boundary',
      actorId: actor.motion.actor.participant.actorId,
      ruleId: 'status.resource-pulse',
      reason: `${resource}:${amount > 0 ? 'increase' : 'decrease'}`,
      amount: Math.abs(amount),
      before,
      after: { ...update.resources },
      causes: [...causes[resource]].sort(compareIds),
    });
  }
}
