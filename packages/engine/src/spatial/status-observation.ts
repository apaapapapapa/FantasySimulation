import type { StatusCohort, MotionState } from './state.ts';
import {
  canonicalJson,
  compareIds,
  type DeepReadonly,
  type Definition,
  type ObservedStatus,
  type StatusAdjustment,
} from '@fantasy/domain/spatial/execution';
import { permanentStatus, statusCategories } from './categories.ts';
import { adjustedStatusValue } from './status-modifiers.ts';
import { statusReactions } from './status-reactions.ts';
import { periodicPulseCount } from './status.ts';

type Status = DeepReadonly<Definition<'status'>>;
export const copyPublicStatuses = (
  states: readonly DeepReadonly<ObservedStatus>[],
): ObservedStatus[] =>
  states.map(({ adjustments, ...s }) => ({
    ...s,
    categories: [...s.categories],
    ...(adjustments && { adjustments: adjustments.map((a) => ({ ...a })) }),
    reactions: s.reactions.map((r) => ({ ...r })),
  }));
/** A signed estimate of a status's benefit to its holder, never an opponent-state lookup. */
export function statusBenefit(
  status: Status,
  horizon = 50,
  remaining = status.durationSteps,
  resources: { mp?: boolean; stamina?: boolean } = {},
  phase?: { startStep: number; fromStep: number },
  withoutDamage = false,
  adjustmentApplies: (adjustment: DeepReadonly<StatusAdjustment>) => boolean = () => true,
) {
  const m = status.modifiers;
  let benefit =
    m.attack / 25 +
    m.defense / 25 +
    (m.speedBps - 10000) / 10000 +
    Number(m.flight) -
    Number(m.rooted) -
    Number(m.silenced ?? false);
  for (const a of status.adjustments ?? []) {
    if (!adjustmentApplies(a)) continue;
    if (a.target === 'staminaRecovery' && resources.stamina === false) continue;
    const divisor = ['attack', 'defense', 'magicPower', 'magicDefense', 'staminaRecovery'].includes(
      a.target,
    )
      ? 25
      : a.target === 'perceptionFov'
        ? 90000
        : 10000;
    const sign = a.target === 'damageTaken' || a.target === 'visibility' ? -1 : 1;
    benefit += sign * (a.operation === 'add' ? a.amount / divisor : (a.amount - 10000) / 10000);
  }
  for (const reaction of statusReactions(status))
    benefit -= ((reaction.damageTakenBps ?? 10000) - 10000) / 10000;
  const duration = permanentStatus(status) ? horizon : Math.min(horizon, remaining);
  benefit *= Math.max(0, duration) / horizon;
  for (const p of status.periodic) {
    if (withoutDamage && p.kind === 'damage') continue;
    if (p.kind === 'resource' && resources[p.resource] === false) continue;
    benefit +=
      (p.kind === 'damage' ? -1 : 1) *
      (p.amount / 25) *
      periodicPulseCount(
        phase?.startStep ?? 0,
        p.everySteps,
        phase?.fromStep ?? 0,
        (phase?.fromStep ?? 0) + Math.max(0, duration),
      );
  }
  return Math.max(-16, Math.min(16, benefit));
}
/** Explicit visibility publishes only coarse semantics: no revision/hash, quantity, stacks or clock. */
export function publicStatuses(statuses: readonly StatusCohort[], step: number): ObservedStatus[] {
  const publicEntries = statuses
    .filter(
      (s) =>
        s.startStep <= step && step < s.endStep && s.revision.definition.visibility === 'visible',
    )
    .map((s) => {
      const definition = s.revision.definition,
        value = statusBenefit(definition);
      return {
        id: s.revision.id,
        categories: [...statusCategories(definition)],
        removable: !permanentStatus(definition),
        benefit:
          value > 0
            ? ('beneficial' as const)
            : value < 0
              ? ('harmful' as const)
              : ('neutral' as const),
        ...(definition.adjustments?.length && {
          adjustments: definition.adjustments.flatMap((a) => {
            const delta = a.amount - (a.operation === 'multiply' ? 10000 : 0);
            return delta
              ? [
                  {
                    target: a.target,
                    direction: delta > 0 ? ('higher' as const) : ('lower' as const),
                    ...(a.element && { element: a.element }),
                    ...(a.category && { category: a.category }),
                  },
                ]
              : [];
          }),
        }),
        reactions: statusReactions(definition).map((r) => ({
          element: r.element,
          response: r.response.kind,
          damage:
            (r.damageTakenBps ?? 10000) > 10000
              ? ('higher' as const)
              : (r.damageTakenBps ?? 10000) < 10000
                ? ('lower' as const)
                : ('normal' as const),
        })),
      };
    });
  return [...new Map(publicEntries.map((s) => [canonicalJson(s), s])).values()]
    .sort((a, b) => compareIds(canonicalJson(a), canonicalJson(b)))
    .slice(0, 64);
}
export function statusVision(
  motion: MotionState,
  statuses: readonly StatusCohort[],
  step: number,
): MotionState {
  const base = motion.actor.character.perception;
  const rangeMm = Math.min(
    200000,
    adjustedStatusValue(base.rangeMm, 'perceptionRange', statuses, step),
  );
  const fovMilliDegrees = Math.min(
    360000,
    adjustedStatusValue(base.fovMilliDegrees, 'perceptionFov', statuses, step),
  );
  const enabled = adjustedStatusValue(10000, 'vision', statuses, step) > 0;
  const visible = adjustedStatusValue(10000, 'visibility', statuses, step) > 0;
  const { vision: _, ...original } = motion;
  return rangeMm === base.rangeMm && fovMilliDegrees === base.fovMilliDegrees && enabled && visible
    ? original
    : { ...original, vision: { rangeMm, fovMilliDegrees, enabled, visible } };
}
