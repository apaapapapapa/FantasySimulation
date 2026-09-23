import type { ResourceState } from '@fantasy/domain/spatial';
import type { ResolvedActor } from './prepare.ts';
import { effectiveStats, periodicPulseCount, type StatusCohort } from './status.ts';
import { calculateDamage } from './damage.ts';
import { damageStatusBps, statusResistance } from './status-modifiers.ts';
import { reactionDamageBps } from './status-reactions.ts';

/** Forecast own periodic damage with the same modifiers and integer damage calculation as combat. */
export function knownPeriodicDamage(
  actor: ResolvedActor,
  statuses: readonly StatusCohort[],
  resources: ResourceState,
  step: number,
  horizonSteps: number,
  fromStep = step + 1,
) {
  const end = fromStep + horizonSteps;
  const boundaries = [
    ...new Set([
      fromStep,
      end,
      ...statuses.flatMap((s) => [s.startStep, s.endStep]).filter((t) => fromStep < t && t < end),
    ]),
  ].sort((a, b) => a - b);
  let damage = 0;
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const at = boundaries[i]!,
      until = boundaries[i + 1]!;
    const stats = effectiveStats(actor, statuses, at);
    damage += statuses.reduce(
      (sum, s) =>
        sum +
        s.revision.definition.periodic.reduce((damage, p) => {
          if (p.kind !== 'damage') return damage;
          const count = periodicPulseCount(
            s.startStep,
            p.everySteps,
            at,
            Math.min(until, s.endStep),
          );
          return (
            damage +
            Number(
              calculateDamage(
                { kind: 'damage', amount: p.amount, attackScaleBps: 0, element: p.element },
                { attack: 0 },
                {
                  ...stats,
                  resistance: statusResistance(
                    actor.character.stats.resistances,
                    statuses,
                    at,
                    p.element,
                  ),
                },
                10000,
                {
                  receivedBps: damageStatusBps(
                    'damageTaken',
                    statuses,
                    at,
                    { element: p.element },
                    reactionDamageBps(statuses, at, p.element),
                  ),
                },
              ).afterModifiers,
            ) *
              count *
              s.stacks
          );
        }, 0),
      0,
    );
  }
  return Math.max(0, damage - resources.shield);
}
