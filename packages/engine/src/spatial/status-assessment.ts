import { abilityEffects, type DeepReadonly, type Effect } from '@fantasy/domain/spatial/execution';
import { statusBenefit } from './status-observation.ts';
import { planStatusEffects } from './status-reactions.ts';
import { applyStatuses, UnresolvedRuleError, type StatusCohort } from './status.ts';
import { knownPeriodicDamage } from './status-risk.ts';
import { SpatialBudgetError } from './physics.ts';
import type { DecisionView } from './perception.ts';
import { abilityCategories } from './categories.ts';
import { reapplicationEstimate } from './threat-memory.ts';

/** Forecast one ability transaction using self knowledge or delayed public summaries only. */
export function assessStatusEffects(
  view: DecisionView,
  effects: readonly DeepReadonly<Effect>[],
  target: 'self' | 'enemy',
  launchStep = view.step,
) {
  const horizon = view.rules.horizonSteps;
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
  const handled = new Set<DeepReadonly<Effect>>();
  const reapplication: NonNullable<ReturnType<typeof reapplicationEstimate>>[] = [];
  const result = (
    value: number,
    risk?: { before: number; after: number; nonDamageValue: number },
  ) => ({
    risk,
    value,
    handled,
    reapplication,
    reason:
      value !== 0
        ? 'defined status benefit/reaction from own knowledge or observed public state'
        : '',
  });
  for (const effect of effects)
    if (
      effect.kind === 'dispel' ||
      (effect.kind === 'water' && (target === 'enemy' || view.ownStatuses !== undefined)) ||
      effect.kind === 'apply-status'
    )
      handled.add(effect);
  if (!own.length && !observed.length && !knownApplications.size) return result(0);
  const resources =
    target === 'self'
      ? {
          mp: view.self.actor.character.stats.mp > 0,
          stamina: view.self.actor.character.stamina !== undefined,
        }
      : {};
  const activationStep = launchStep + 1;
  const benefit = (states: readonly StatusCohort[], withoutDamage = false) =>
    states.reduce(
      (sum, s) =>
        sum +
        statusBenefit(
          s.revision.definition,
          horizon,
          s.endStep - activationStep,
          resources,
          {
            startStep: s.startStep,
            fromStep: activationStep,
          },
          withoutDamage,
          (adjustment) =>
            target === 'enemy' ||
            adjustment.target !== 'damageDealt' ||
            view.self.actor.abilities.some(
              ({ definition }) =>
                (!adjustment.category ||
                  abilityCategories(definition).includes(adjustment.category)) &&
                abilityEffects(definition).some(
                  (e) =>
                    e.kind === 'damage' &&
                    (!adjustment.element || e.element === adjustment.element),
                ),
            ),
        ) *
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
      const after = applyStatuses(
        plan.statuses,
        plan.applications,
        plan.dispels,
        activationStep,
      ).statuses;
      const removed = active.filter((s) => !after.some((a) => a.revision.id === s.revision.id));
      for (const s of removed) {
        const estimate = reapplicationEstimate(view, s.revision.id, activationStep);
        if (estimate) reapplication.push(estimate);
      }
      const limited = active.map((s) => {
        const estimate = reapplication.find((e) => e.statusId === s.revision.id);
        return estimate
          ? { ...s, endStep: Math.min(s.endStep, activationStep + estimate.effectiveSteps) }
          : s;
      });
      const damage = (states: readonly StatusCohort[]) =>
        knownPeriodicDamage(
          view.self.actor,
          states,
          view.resources,
          activationStep,
          horizon,
          activationStep,
        );
      const beforeDamage = damage(limited),
        afterDamage = damage(after);
      if (beforeDamage === undefined || afterDamage === undefined) return result(0);
      return result(
        benefit(after) - benefit(limited),
        beforeDamage || afterDamage
          ? {
              before: beforeDamage,
              after: afterDamage,
              nonDamageValue: benefit(after, true) - benefit(limited, true),
            }
          : undefined,
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
