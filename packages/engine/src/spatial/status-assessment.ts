import type { DeepReadonly, Effect } from '@fantasy/domain/spatial';
import { dispelTargets } from './categories.ts';
import { generalizedStatus, statusBenefit } from './status-observation.ts';
import { planStatusReactions } from './status-reactions.ts';
import { applyStatuses, UnresolvedRuleError, type StatusCohort } from './status.ts';
import { SpatialBudgetError } from './physics.ts';
import type { DecisionView } from './perception.ts';

/** Only own definitions/active states and delayed public opponent summaries enter status utility. */
export function assessStatusEffect(
  view: DecisionView,
  effect: DeepReadonly<Effect>,
  target: 'self' | 'enemy',
  includeReaction = true,
) {
  const horizon = view.rules?.horizonSteps ?? 50,
    step = view.step ?? 0;
  const own = view.ownStatuses ?? [];
  const observed = (view.memory.observation?.enemy ?? view.memory.lastSeen)?.statuses ?? [];
  const definitions = view.self.actor.knownStatuses ?? [];
  const resources =
    target === 'self'
      ? {
          mp: view.self.actor.character.stats.mp > 0,
          stamina: view.self.actor.character.stamina !== undefined,
        }
      : {};
  let value = 0,
    handled = false;
  const activationStep = step + 1;
  const benefit = (states: readonly StatusCohort[]) =>
    states.reduce(
      (sum, s) =>
        sum +
        statusBenefit(s.revision.definition, horizon, s.endStep - activationStep, resources) *
          s.stacks,
      0,
    );
  const marginal = (resolve: () => readonly StatusCohort[]) => {
    try {
      return benefit(resolve()) - benefit(own);
    } catch (error) {
      // This is a self-only forecast. Actual resolution still reports these failures normally.
      if (error instanceof UnresolvedRuleError || error instanceof SpatialBudgetError) return 0;
      throw error;
    }
  };
  if (effect.kind === 'apply-status') {
    const status = definitions.find(
      (s) =>
        s.id === effect.status.id &&
        s.revision === effect.status.revision &&
        s.contentHash === effect.status.contentHash,
    );
    if (status && generalizedStatus(status.definition)) {
      handled = true;
      value =
        target === 'self'
          ? marginal(
              () =>
                applyStatuses(
                  own,
                  [{ revision: status, cause: 'decision.status' }],
                  [],
                  activationStep,
                ).statuses,
            )
          : -statusBenefit(status.definition, horizon, status.definition.durationSteps, resources);
    }
  } else if (effect.kind === 'dispel') {
    if (target === 'self' && own.some((s) => generalizedStatus(s.revision.definition))) {
      handled = true;
      const matches = dispelTargets(
        effect,
        own.map((s) => s.revision),
      );
      value = marginal(() => applyStatuses(own, [], matches, activationStep).statuses);
    } else if (target === 'enemy' && observed.length) {
      handled = true;
      for (const s of observed)
        if (
          s.removable &&
          (effect.statusIds?.includes(s.id) ||
            effect.categories?.some((c) => s.categories.includes(c)))
        )
          value += s.benefit === 'beneficial' ? 1 : s.benefit === 'harmful' ? -1 : 0;
    }
  } else if (effect.kind === 'damage' || effect.kind === 'water') {
    const element = effect.kind === 'water' ? 'water' : effect.element;
    if (target === 'self' && own.some((s) => generalizedStatus(s.revision.definition))) {
      handled = effect.kind === 'water';
      if (includeReaction)
        value = marginal(() => {
          const plan = planStatusReactions(
            own,
            [{ id: 'decision.status', element }],
            definitions,
            step,
          );
          return applyStatuses(plan.statuses, plan.applications, plan.dispels, activationStep)
            .statuses;
        });
    } else if (target === 'enemy') {
      handled = effect.kind === 'water' && observed.length > 0;
      for (const s of observed) {
        if (!includeReaction) continue;
        const reaction = s.reactions.find((r) => r.element === element),
          benefit = s.benefit === 'beneficial' ? 1 : s.benefit === 'harmful' ? -1 : 0;
        if (!reaction) continue;
        if (reaction.response === 'strengthen') value -= benefit;
        else if (
          s.removable &&
          (reaction.response === 'remove' || reaction.response === 'transform')
        )
          value += benefit;
      }
    }
  }
  return {
    value,
    handled,
    reason:
      value !== 0
        ? 'defined status benefit/reaction from own knowledge or observed public state'
        : '',
  };
}

/** Coarse visible weakness affects the prior only; measured impacts already include it. */
export function observedDamagePrior(
  view: DecisionView,
  element: Extract<Effect, { kind: 'damage' }>['element'],
) {
  const observed = (view.memory.observation?.enemy ?? view.memory.lastSeen)?.statuses ?? [];
  let bps = 10000;
  for (const status of observed) {
    const reaction = status.reactions.find((r) => r.element === element);
    bps += reaction?.damage === 'higher' ? 2500 : reaction?.damage === 'lower' ? -2500 : 0;
    for (const adjustment of status.adjustments ?? []) {
      if (adjustment.element && adjustment.element !== element) continue;
      if (adjustment.target !== 'damageTaken' && adjustment.target !== 'resistance') continue;
      const higher = adjustment.direction === 'higher';
      bps += (adjustment.target === 'resistance' ? !higher : higher) ? 2500 : -2500;
    }
  }
  return Math.max(2500, Math.min(30000, bps));
}
