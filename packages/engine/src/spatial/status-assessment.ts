import type { DeepReadonly, Effect } from '@fantasy/domain/spatial';
import { generalizedStatus, statusBenefit } from './status-observation.ts';
import { planStatusEffects } from './status-reactions.ts';
import { applyStatuses, UnresolvedRuleError, type StatusCohort } from './status.ts';
import { SpatialBudgetError } from './physics.ts';
import type { DecisionView } from './perception.ts';

/** Forecast one ability transaction using self knowledge or delayed public summaries only. */
export function assessStatusEffects(
  view: DecisionView,
  effects: readonly DeepReadonly<Effect>[],
  target: 'self' | 'enemy',
  launchStep = view.step ?? 0,
) {
  const horizon = view.rules?.horizonSteps ?? 50;
  const own = view.ownStatuses ?? [];
  const observed = (view.memory.observation?.enemy ?? view.memory.lastSeen)?.statuses ?? [];
  const definitions = view.self.actor.knownStatuses ?? [];
  const knownApplications = new Map(
    effects.flatMap((effect) => {
      if (effect.kind !== 'apply-status') return [];
      const ref = effect.status;
      const revision = definitions.find(
        (s) => s.id === ref.id && s.revision === ref.revision && s.contentHash === ref.contentHash,
      );
      return revision ? [[effect, revision] as const] : [];
    }),
  );
  const generalized =
    (target === 'self'
      ? own.some((s) => generalizedStatus(s.revision.definition))
      : observed.length > 0) ||
    [...knownApplications.values()].some((s) => generalizedStatus(s.definition));
  const handled = new Set<DeepReadonly<Effect>>();
  const result = (value: number) => ({
    value,
    handled,
    reason:
      value !== 0
        ? 'defined status benefit/reaction from own knowledge or observed public state'
        : '',
  });
  if (!generalized) return result(0);
  for (const effect of effects)
    if (
      effect.kind === 'dispel' ||
      effect.kind === 'water' ||
      (effect.kind === 'apply-status' && knownApplications.has(effect))
    )
      handled.add(effect);
  const resources =
    target === 'self'
      ? {
          mp: view.self.actor.character.stats.mp > 0,
          stamina: view.self.actor.character.stamina !== undefined,
        }
      : {};
  const activationStep = launchStep + 1;
  const benefit = (states: readonly StatusCohort[]) =>
    states.reduce(
      (sum, s) =>
        sum +
        statusBenefit(s.revision.definition, horizon, s.endStep - activationStep, resources, {
          startStep: s.startStep,
          fromStep: activationStep,
        }) *
          s.stacks,
      0,
    );
  const forecastEffects = effects
    .filter((e) => e.kind !== 'apply-status' || knownApplications.has(e))
    .map((effect, index) => ({ id: `decision.status.${index}`, effect }));
  try {
    if (target === 'self') {
      const active = own.filter((s) => s.startStep <= launchStep && launchStep < s.endStep);
      const plan = planStatusEffects(active, forecastEffects, definitions, launchStep);
      return result(
        benefit(
          applyStatuses(plan.statuses, plan.applications, plan.dispels, activationStep).statuses,
        ) - benefit(active),
      );
    }
    // Incoming definitions are known; enemy stack counts, clocks and transform destinations are not.
    const grants = planStatusEffects(
      [],
      forecastEffects.filter((a) => a.effect.kind === 'apply-status'),
      definitions,
      launchStep,
    );
    let value = -benefit(applyStatuses([], grants.applications, [], activationStep).statuses);
    const elements = new Set(
      effects.flatMap((e) =>
        e.kind === 'water' ? ['water'] : e.kind === 'damage' ? [e.element] : [],
      ),
    );
    for (const status of observed) {
      const reactions = status.reactions.filter((r) => elements.has(r.element));
      const remove =
        status.removable &&
        (effects.some(
          (e) =>
            e.kind === 'dispel' &&
            (e.statusIds?.includes(status.id) ||
              e.categories?.some((c) => status.categories.includes(c))),
        ) ||
          reactions.some((r) => r.response === 'remove' || r.response === 'transform'));
      const sign = status.benefit === 'beneficial' ? 1 : status.benefit === 'harmful' ? -1 : 0;
      if (remove) value += sign;
      else if (reactions.some((r) => r.response === 'strengthen')) value -= sign;
    }
    return result(value);
  } catch (error) {
    // Forecast failure grants no utility; actual resolution still reports its diagnostic.
    if (error instanceof UnresolvedRuleError || error instanceof SpatialBudgetError)
      return result(0);
    throw error;
  }
}

/** Single-effect entry point for callers without an ability clock. */
export function assessStatusEffect(
  view: DecisionView,
  effect: DeepReadonly<Effect>,
  target: 'self' | 'enemy',
) {
  const result = assessStatusEffects(view, [effect], target);
  return { ...result, handled: result.handled.has(effect) };
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
