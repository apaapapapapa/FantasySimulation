import type {
  AbilityCategory,
  Definition,
  Effect,
  StatusAdjustment,
} from '@fantasy/domain/spatial/execution';
import type { StatusCohort } from './status.ts';

export type ModifierSelector = {
  element?: Extract<Effect, { kind: 'damage' }>['element'];
  categories?: readonly AbilityCategory[];
};
/** All multipliers contribute their deviation from 10000, matching legacy speed stacking. */
export function statusAdjustmentTotals(
  target: StatusAdjustment['target'],
  statuses: readonly StatusCohort[],
  step: number,
  selector: ModifierSelector = {},
  initialBps = 10000,
) {
  let addition = 0,
    multiplier = initialBps;
  for (const cohort of statuses) {
    if (cohort.startStep > step || step >= cohort.endStep) continue;
    for (const adjustment of cohort.revision.definition.adjustments ?? []) {
      if (
        adjustment.target !== target ||
        (adjustment.element && adjustment.element !== selector.element) ||
        (adjustment.category && !selector.categories?.includes(adjustment.category))
      )
        continue;
      if (adjustment.operation === 'add') addition += adjustment.amount * cohort.stacks;
      else multiplier += (adjustment.amount - 10000) * cohort.stacks;
    }
  }
  return { addition, multiplier: Math.max(0, Math.min(30000, multiplier)) };
}
export function adjustedStatusValue(
  base: number,
  target: StatusAdjustment['target'],
  statuses: readonly StatusCohort[],
  step: number,
  selector: ModifierSelector = {},
  initialBps = 10000,
): number {
  const { addition, multiplier } = statusAdjustmentTotals(
    target,
    statuses,
    step,
    selector,
    initialBps,
  );
  return Number((BigInt(Math.max(0, base + addition)) * BigInt(multiplier)) / 10000n);
}
export function statusResistance(
  resistances: Definition<'character'>['stats']['resistances'],
  statuses: readonly StatusCohort[],
  step: number,
  element: NonNullable<ModifierSelector['element']>,
) {
  return Math.min(
    10000,
    adjustedStatusValue(resistances[element] ?? 0, 'resistance', statuses, step, { element }),
  );
}
export const damageStatusBps = (
  target: 'damageDealt' | 'damageTaken',
  statuses: readonly StatusCohort[],
  step: number,
  selector: ModifierSelector,
  reactionBps = 10000,
) => Math.min(30000, adjustedStatusValue(10000, target, statuses, step, selector, reactionBps));
