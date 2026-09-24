import type { ResourceState } from '@fantasy/domain/spatial/execution';
import type { ResolvedActor } from './prepare.ts';
import { statusBoundary, UnresolvedRuleError, type StatusCohort } from './status.ts';
import { resolveEffects, type EffectApplication } from './effects.ts';
import { SpatialBudgetError } from './physics.ts';

/** Bounded own-state forecast through combat's expiry, pulse and reaction transaction. */
export function knownPeriodicDamage(
  actor: ResolvedActor,
  statuses: readonly StatusCohort[],
  resources: ResourceState,
  step: number,
  horizonSteps: number,
  fromStep = step + 1,
) {
  const end = fromStep + horizonSteps,
    targetId = actor.participant.actorId;
  let current = [...statuses],
    balance = { ...resources },
    damage = 0,
    cursor = fromStep;
  try {
    while (cursor < end) {
      // Jump to the next damage pulse, including newly transformed statuses. No recursive pulses.
      const at = Math.min(
        end,
        ...current.flatMap((s) =>
          s.revision.definition.periodic.flatMap((p) => {
            if (p.kind !== 'damage') return [];
            const t =
              s.startStep +
              Math.max(0, Math.ceil((cursor - s.startStep) / p.everySteps)) * p.everySteps;
            return t < s.endStep ? [t] : [];
          }),
        ),
      );
      if (at >= end) break;
      const boundary = statusBoundary(current, at);
      const applications: EffectApplication[] = boundary.pulses.flatMap((p, i) =>
        p.effect.kind !== 'damage'
          ? []
          : [
              {
                id: 'forecast.' + at + '.' + i,
                actorId: null,
                targetId,
                attack: 0,
                effect: {
                  kind: 'damage',
                  amount: p.effect.amount,
                  element: p.effect.element,
                  attackScaleBps: 0,
                },
              },
            ],
      );
      const next = resolveEffects(
        [{ actor, resources: balance, statuses: boundary.statuses }],
        applications,
        actor.knownStatuses ?? [],
        at,
        at,
      )[0]!;
      damage += next.hpDamage;
      current = next.statuses;
      balance = next.resources;
      cursor = at + 1;
    }
    return damage;
  } catch (error) {
    // Forecast uncertainty must not publish an actual future diagnostic at the current boundary.
    if (error instanceof UnresolvedRuleError || error instanceof SpatialBudgetError)
      return undefined;
    throw error;
  }
}
