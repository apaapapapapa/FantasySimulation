import type { AbilityRevision, DecisionView } from '../state.ts';
import {
  canonicalJson,
  matchEffect,
  type EffectHandlers,
  type CandidateAssessment,
  type DeepReadonly,
  type Definition,
  type DamageDefense,
} from '@fantasy/domain/spatial/execution';
import { conditionMatches } from '../rules/conditions.ts';
import { length, sub } from '../math.ts';
import { actionClock, payCost } from '../rules/attacks.ts';
import { ResourceBudget, staminaExhausted } from '../rules/resources.ts';
import { damagePower, damageDefense } from '../rules/damage.ts';
import { assessStatusEffects, observedDamagePrior } from './status-assessment.ts';
import { adjustedStatusValue, damageStatusBps } from '../rules/status-modifiers.ts';
import { abilityCategories } from '../rules/categories.ts';
import { appearancePrior } from './appearance.ts';
import { shapeEstimate, stageMotionEstimate } from './shape-assessment.ts';
import { abilityPlan, authoredStages } from '../rules/ability-plan.ts';

export const clampBps = (n: number) => Math.max(0, Math.min(10000, Math.round(n)));
export const boundedWeight = (n: number) => Math.max(0, Math.min(1_000_000, Math.round(n)));
type DamageElement = Extract<
  Definition<'ability'>['effects'][number],
  { kind: 'damage' }
>['element'];
export function efficacy(
  view: DecisionView,
  element: DamageElement,
  power: number,
  defense: DamageDefense = 'physical',
) {
  const target = view.memory.observation?.enemy ?? view.memory.lastSeen,
    step = view.step;
  const evidence = view.memory.knowledge.filter(
    (e) => e.targetId === target?.id && e.element === element && e.expiresAt > step,
  );
  const revealed = evidence.filter((e) => e.kind === 'reveal').at(-1);
  const statusPrior = observedDamagePrior(view, element);
  if (revealed?.range)
    return {
      bps: Math.min(
        30000,
        Math.round(
          ((10000 - (revealed.range.low + revealed.range.high) / 2) * statusPrior) / 10000,
        ),
      ),
      confidence: statusPrior === 10000 ? 10000 : 1000,
      evidence: [revealed.eventId],
    };
  const comparable = evidence.filter(
    (e) =>
      e.kind === 'impact' &&
      canonicalJson(e.observedStatuses ?? []) === canonicalJson(target?.statuses ?? []) &&
      (e.defense ?? 'physical') === defense &&
      (e.range || (e.impactBand && view.rules.relativeImpactBps)) &&
      e.basePower > 0 &&
      Math.abs(e.basePower - power) <= Math.max(1, power * 0.2) &&
      e.distanceBand ===
        Math.min(200, Math.floor(length(sub(target!.position, view.self.position)) / 2)),
  );
  if (comparable.length) {
    const average =
      comparable.reduce((n, e) => {
        if (e.range) return n + (e.range.low + e.range.high) / 2 / e.basePower;
        const [a, b, c] = view.rules.relativeImpactBps!;
        const ranges = {
          minimal: [0, a],
          weak: [a, b],
          normal: [b, c],
          strong: [c, Math.min(30000, c * 2)],
        };
        const range = ranges[e.impactBand!];
        return n + (range[0]! + range[1]!) / 20000;
      }, 0) / comparable.length;
    return {
      bps: Math.min(30000, Math.round(average * 10000)),
      confidence: Math.min(9000, comparable.length * 2500),
      evidence: comparable.map((e) => e.eventId),
    };
  }
  const prior = appearancePrior(target?.appearance, element, view.rules.appearancePriors);
  return {
    bps: Math.min(30000, Math.round((prior.bps * statusPrior) / 10000)),
    confidence: prior.confidence,
    evidence: [],
  };
}
export function assessAbility(view: DecisionView, ability: AbilityRevision): CandidateAssessment {
  return abilityPlan(ability).kind === 'staged'
    ? assessStages(view, ability)
    : assessSingle(view, ability).assessment;
}
function assessSingle(
  view: DecisionView,
  ability: AbilityRevision,
  timing?: { cast: number; duration: number },
) {
  const rules = view.rules,
    weights = view.self.actor.policy.evaluation ?? {
      attackBps: 10000,
      survivalBps: 10000,
      explorationBps: 10000,
    };
  const target = view.memory.observation?.enemy ?? view.memory.lastSeen,
    d = ability.definition;
  const clock = actionClock(d, view.self.actor.character.stats.actionSpeedBps, 0);
  const duration = timing?.duration ?? clock?.recoveryUntil ?? 8000,
    cast = timing?.cast ?? clock?.launchAt ?? 8000;
  const burnRisk = Math.min(1, (view.burnDamage ?? 0) / Math.max(1, view.resources.hp));
  const riskAversion = (20000 - (weights.riskToleranceBps ?? 10000)) / 10000;
  const costConcern = (weights.resourceConservationBps ?? 10000) / 10000;
  const beforeHitRisk = Math.min(1, (burnRisk * Math.max(1, cast)) / rules.horizonSteps);
  const observedThreat =
    (view.memory.observation?.projectiles.length ?? 0) * 0.15 +
    (target?.action === 'cast' ? 0.25 : target?.action === 'active' ? 0.4 : 0);
  const exposure = Math.min(1, (observedThreat * duration * riskAversion) / rules.horizonSteps);
  const costBps = clampBps(
    10000 *
      (d.costs.hp / Math.max(1, view.resources.hp) +
        d.costs.mp / Math.max(1, view.resources.mp) +
        (d.costs.stamina ?? 0) / Math.max(1, view.resources.stamina ?? 0)),
  );
  let utility = 0,
    success = 10000,
    kill = 0,
    efficiency = 10000,
    confidence = 10000,
    exploration = 0,
    totalPower = 0,
    totalExpected = 0,
    confidencePower = 0;
  const evidence: string[] = [],
    reasons: string[] = [];
  const effects = abilityPlan(ability).effects;
  const stateValue = assessStatusEffects(view, effects, d.target, view.step + cast);
  utility += (stateValue.risk?.nonDamageValue ?? stateValue.value) * rules.actionWeight;
  if (stateValue.risk) {
    const { before, after } = stateValue.risk;
    const reduction = (before - after) / Math.max(1, before, after);
    const risk = Math.min(1, Math.max(before, after) / Math.max(1, view.resources.hp));
    utility +=
      (reduction *
        (rules.actionWeight + rules.riskWeight * (0.65 + 2 * risk)) *
        weights.survivalBps) /
      10000;
  }
  if (stateValue.reason) reasons.push(stateValue.reason);
  const effectAssessments: EffectHandlers<undefined, void> = {
    damage: (effect) => {
      if (d.target !== 'enemy') return;
      const power = Number(
        damagePower(effect, {
          attack: view.attack,
          magicPower: view.magicPower,
        }),
      );
      const base = Math.floor(
        (power *
          damageStatusBps('damageDealt', view.ownStatuses ?? [], view.step, {
            element: effect.element,
            categories: abilityCategories(d),
          })) /
          10000,
      );
      const known = efficacy(view, effect.element, base, damageDefense(effect)),
        expected = (base * known.bps) / 10000;
      totalPower += base;
      totalExpected += expected;
      confidencePower += base * known.confidence;
      evidence.push(...known.evidence);
    },
    water: (_effect) => {
      if (d.target !== 'self' || !view.waterExtinguishable) return;
      utility +=
        ((rules.actionWeight + rules.riskWeight * (0.65 + 2 * burnRisk)) * weights.survivalBps) /
        10000;
      reasons.push('known burning; reduce continuing self damage');
    },
    heal: (effect) => {
      if (d.target !== 'self') return;
      utility +=
        (((rules.riskWeight *
          Math.min(
            Math.floor(
              (effect.amount *
                Math.min(
                  30000,
                  adjustedStatusValue(10000, 'hpRecovery', view.ownStatuses ?? [], view.step),
                )) /
                10000,
            ),
            view.self.actor.character.stats.hp - view.resources.hp,
          )) /
          Math.max(1, view.resources.hp)) *
          weights.survivalBps) /
        10000;
      reasons.push('self-perceived wounds');
    },
    shield: (effect) => {
      if (d.target !== 'self') return;
      utility +=
        rules.actionWeight *
        Math.min(2, effect.amount / Math.max(1, view.resources.shield + 10)) *
        (view.memory.observation?.projectiles.length ? 2 : 1);
      reasons.push('self protection');
    },
    force: (effect) => {
      const displacement = (effect.speedMmPerSecond / 1000) * effect.durationSteps * 0.02;
      utility += rules.actionWeight * Math.min(1, displacement / 4) * (target ? 0.5 : 0.1);
      confidence = Math.min(confidence, 1000);
      success = Math.min(success, Math.round(6500 * shapeEstimate(view, d.attack)));
      reasons.push(
        `own ${effect.direction} force ${effect.durationSteps} steps; capped displacement, collisions unknown`,
      );
    },
    reveal: (effect) => {
      const known = efficacy(view, effect.element, 1);
      utility +=
        (rules.explorationWeight *
          3 *
          (1 - known.confidence / 10000) *
          (1 - burnRisk) *
          weights.explorationBps) /
        10000;
      reasons.push('bounded information acquisition');
    },
    'apply-status': () => {}, // Already assessed together by the status transaction above.
    dispel: () => {},
  };
  for (const effect of effects) {
    if (!stateValue.handled.has(effect)) matchEffect(effect, effectAssessments, undefined);
  }
  if (totalPower > 0) {
    const expected = totalExpected;
    efficiency = Math.round((totalExpected / totalPower) * 10000);
    confidence = clampBps(confidencePower / totalPower);
    const motion = target ? length(target.velocity) : 0;
    success = clampBps(
      8500 -
        d.aimErrorMilliDegrees / 10 -
        motion * 150 -
        (view.memory.observation?.enemy ? 0 : 2500),
    );
    success = clampBps(success * shapeEstimate(view, d.attack));
    const healthFraction =
      target?.wounds === 'critical'
        ? 0.25
        : target?.wounds === 'severe'
          ? 0.5
          : target?.wounds === 'hurt'
            ? 0.85
            : 1;
    const certainty = confidence / 10000;
    kill = clampBps(
      success *
        Math.min(1, expected / Math.max(1, rules.healthPrior * healthFraction)) *
        (0.1 + 0.9 * certainty),
    );
    exploration +=
      (rules.explorationWeight * (1 - certainty) * (1 - burnRisk) * weights.explorationBps) / 10000;
    utility +=
      (((rules.actionWeight * Math.min(8, expected / 25) * success) / 10000 / (1 + 3 * burnRisk) +
        ((rules.killWeight * kill) / 10000) * (1 - beforeHitRisk) ** 2) *
        weights.attackBps) /
      10000;
    reasons.push('own-power/coarse-impact/visible-wounds; kill is an estimate');
  }
  const score =
    ((utility + exploration) * (1 - 0.6 * exposure)) /
    (1 + duration / rules.horizonSteps) /
    (1 + (costBps * costConcern) / 5000);
  const assessment: CandidateAssessment = {
    key: `ability:${ability.id}`,
    kind: 'ability',
    abilityId: ability.id,
    weight: boundedWeight(score),
    totalWeight: 1,
    successBps: success,
    killBps: kill,
    survivalBps: clampBps(10000 * (1 - beforeHitRisk - exposure)),
    efficacyBps: efficiency,
    confidenceBps: confidence,
    durationSteps: Math.min(8000, duration),
    costBps,
    exploration: Math.round(exploration),
    evidence: [...new Set(evidence)].slice(-32),
    ...(stateValue.reapplication.length ? { reapplication: stateValue.reapplication } : {}),
    reason: reasons.join('; ').slice(0, 300),
  };
  return { assessment, score };
}
/** Reuse the same utility terms for each reachable own stage; physical offsets are never speed-scaled again. */
function assessStages(view: DecisionView, ability: AbilityRevision): CandidateAssessment {
  const { stages: _stages, ...definition } = ability.definition;
  const plan = authoredStages(ability);
  const clock = actionClock(ability.definition, view.self.actor.character.stats.actionSpeedBps, 0);
  const duration = clock?.recoveryUntil ?? 8000;
  const costs = plan.reduce(
    (sum, stage) => ({
      ...sum,
      hp: sum.hp + (stage.cost?.hp ?? 0),
      mp: sum.mp + (stage.cost?.mp ?? 0),
      stamina:
        (sum.stamina ?? 0) + (stage.cost?.stamina ?? 0) + stageMotionEstimate(view, stage).jumpCost,
    }),
    { ...definition.costs },
  );
  const initial = payCost(
    ability.definition,
    view.resources,
    view.used[ability.id] ?? 0,
    !view.staminaExhausted,
  );
  let resources = initial.resources;
  const parts: ReturnType<typeof assessSingle>[] = [];
  if (initial.ok)
    for (const [index, stage] of plan.entries()) {
      const motion = stageMotionEstimate(view, stage);
      if (!motion.feasible) break;
      if (stage.startCondition && !conditionMatches(stage.startCondition, { ...view, resources }))
        break;
      if (stage.interruptWhen && conditionMatches(stage.interruptWhen, { ...view, resources }))
        break;
      if ((index > 0 && stage.cost) || motion.jumpCost) {
        const budget = new ResourceBudget(
          resources,
          {},
          !staminaExhausted(resources, view.self.actor.character.stamina, view.staminaExhausted),
        );
        if (
          !budget.reserve('estimate', [
            ...(index > 0 && stage.cost ? [stage.cost] : []),
            { stamina: motion.jumpCost },
          ]).ok
        )
          break;
        resources = budget.commit('estimate').after;
      }
      if (!stage.attack) continue;
      parts.push(
        assessSingle(
          { ...view, resources },
          {
            ...ability,
            definition: { ...definition, costs, attack: stage.attack, effects: stage.effects },
          },
          { cast: (clock?.launchAt ?? 8000) + stage.offsetSteps, duration },
        ),
      );
      if (stage.selfMotion) parts.at(-1)!.score *= 1 - motion.exposure;
    }
  const fallback = assessSingle(
    view,
    { ...ability, definition },
    { cast: clock?.launchAt ?? 8000, duration },
  ).assessment;
  const average = (key: 'successBps' | 'efficacyBps' | 'confidenceBps') =>
    parts.length ? Math.round(parts.reduce((n, p) => n + p.assessment[key], 0) / parts.length) : 0;
  return {
    ...fallback,
    weight: boundedWeight(parts.reduce((n, p) => n + p.score, 0)),
    durationSteps: Math.min(8000, duration),
    successBps: average('successBps'),
    efficacyBps: average('efficacyBps'),
    confidenceBps: average('confidenceBps'),
    killBps: clampBps(parts.reduce((n, p) => n + p.assessment.killBps, 0)),
    survivalBps: Math.min(fallback.survivalBps, ...parts.map((p) => p.assessment.survivalBps)),
    costBps: Math.max(fallback.costBps, ...parts.map((p) => p.assessment.costBps)),
    evidence: [...new Set(parts.flatMap((p) => p.assessment.evidence))].slice(-32),
    reason: `${plan.length} own stages, ${parts.length} presently affordable releases; physical timing, combined cost and exposure estimate${plan.some((s) => s.selfMotion || s.attack?.kind === 'arc' || s.attack?.kind === 'radial') ? '; own shape/coverage and motion estimate' : ''}`,
  };
}

export type KnownClearance = (
  from: DeepReadonly<DecisionView['self']['position']>,
  to: DeepReadonly<DecisionView['self']['position']>,
  body?: DeepReadonly<Definition<'character'>['body']>,
) => boolean;
