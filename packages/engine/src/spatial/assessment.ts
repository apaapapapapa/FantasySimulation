import {
  AI_RULES,
  type CandidateAssessment,
  type DeepReadonly,
  type Definition,
  type DamageDefense,
} from '@fantasy/domain/spatial';
import type { AbilityRevision } from './combat-state.ts';
import type { DecisionView } from './perception.ts';
import { length, sub } from './math.ts';
import { actionClock } from './attacks.ts';
import { damagePower, damageDefense } from './damage.ts';
import { assessStatusEffect, observedDamagePrior } from './status-assessment.ts';
import { adjustedStatusValue, damageStatusBps } from './status-modifiers.ts';
import { abilityCategories } from './categories.ts';

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
    step = view.step ?? 0;
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
      (e.defense ?? 'physical') === defense &&
      e.range &&
      e.basePower > 0 &&
      Math.abs(e.basePower - power) <= Math.max(1, power * 0.2) &&
      e.distanceBand ===
        Math.min(200, Math.floor(length(sub(target!.position, view.self.position)) / 2)),
  );
  if (comparable.length) {
    const average =
      comparable.reduce((n, e) => n + (e.range!.low + e.range!.high) / 2 / e.basePower, 0) /
      comparable.length;
    return {
      bps: Math.min(30000, Math.round(average * 10000)),
      confidence: Math.min(9000, comparable.length * 2500),
      evidence: comparable.map((e) => e.eventId),
    };
  }
  const surface = target?.appearance?.surface;
  const prior =
    (surface === 'red' && element === 'fire') || (surface === 'blue' && element === 'ice')
      ? 6500
      : 7500;
  return {
    bps: Math.min(30000, Math.round((prior * statusPrior) / 10000)),
    confidence: surface === 'red' || surface === 'blue' ? 1000 : 0,
    evidence: [],
  };
}
export function assessAbility(view: DecisionView, ability: AbilityRevision): CandidateAssessment {
  const rules = view.rules ?? AI_RULES,
    weights = view.self.actor.policy.evaluation ?? {
      attackBps: 10000,
      survivalBps: 10000,
      explorationBps: 10000,
    };
  const target = view.memory.observation?.enemy ?? view.memory.lastSeen,
    d = ability.definition;
  const clock = actionClock(d, view.self.actor.character.stats.actionSpeedBps, 0);
  const duration = clock?.recoveryUntil ?? 8000,
    cast = clock?.launchAt ?? 8000;
  const burnRisk = Math.min(1, (view.burnDamage ?? 0) / Math.max(1, view.resources.hp));
  const beforeHitRisk = Math.min(1, (burnRisk * Math.max(1, cast)) / rules.horizonSteps);
  const observedThreat =
    (view.memory.observation?.projectiles.length ?? 0) * 0.15 +
    (target?.action === 'cast' ? 0.25 : target?.action === 'active' ? 0.4 : 0);
  const exposure = Math.min(1, (observedThreat * duration) / rules.horizonSteps);
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
  const reacted = new Set<string>();
  for (const effect of d.effects) {
    const element =
      effect.kind === 'water' ? 'water' : effect.kind === 'damage' ? effect.element : null;
    const stateValue = assessStatusEffect(
      view,
      effect,
      d.target,
      !element || !reacted.has(element),
    );
    if (element) reacted.add(element);
    utility += stateValue.value * rules.actionWeight;
    if (stateValue.reason) reasons.push(stateValue.reason);
    if (stateValue.handled) continue;
    if (effect.kind === 'damage' && d.target === 'enemy') {
      const power = Number(
        damagePower(effect, {
          attack: view.attack ?? view.self.actor.character.stats.attack,
          magicPower:
            view.magicPower ??
            view.self.actor.character.stats.magicPower ??
            view.attack ??
            view.self.actor.character.stats.attack,
        }),
      );
      const base = Math.floor(
        (power *
          damageStatusBps('damageDealt', view.ownStatuses ?? [], view.step ?? 0, {
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
    } else if (effect.kind === 'water' && d.target === 'self' && view.waterExtinguishable) {
      utility +=
        ((rules.actionWeight + rules.riskWeight * (0.65 + 2 * burnRisk)) * weights.survivalBps) /
        10000;
      reasons.push('known burning; reduce continuing self damage');
    } else if (effect.kind === 'heal' && d.target === 'self') {
      utility +=
        (((rules.riskWeight *
          Math.min(
            Math.floor(
              (effect.amount *
                Math.min(
                  30000,
                  adjustedStatusValue(10000, 'hpRecovery', view.ownStatuses ?? [], view.step ?? 0),
                )) /
                10000,
            ),
            view.self.actor.character.stats.hp - view.resources.hp,
          )) /
          Math.max(1, view.resources.hp)) *
          weights.survivalBps) /
        10000;
      reasons.push('self-perceived wounds');
    } else if (effect.kind === 'shield' && d.target === 'self') {
      utility +=
        rules.actionWeight *
        Math.min(2, effect.amount / Math.max(1, view.resources.shield + 10)) *
        (view.memory.observation?.projectiles.length ? 2 : 1);
      reasons.push('self protection');
    } else if (effect.kind === 'reveal') {
      const known = efficacy(view, effect.element, 1);
      utility +=
        (rules.explorationWeight *
          3 *
          (1 - known.confidence / 10000) *
          (1 - burnRisk) *
          weights.explorationBps) /
        10000;
      reasons.push('bounded information acquisition');
    } else if (effect.kind === 'apply-status' || effect.kind === 'dispel') {
      utility += rules.actionWeight;
      reasons.push('known status effect');
    }
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
  const weight = boundedWeight(
    ((utility + exploration) * (1 - 0.6 * exposure)) /
      (1 + duration / rules.horizonSteps) /
      (1 + costBps / 5000),
  );
  return {
    key: `ability:${ability.id}`,
    kind: 'ability',
    abilityId: ability.id,
    weight,
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
    reason: reasons.join('; ').slice(0, 300),
  };
}
export type KnownClearance = (
  from: DeepReadonly<DecisionView['self']['position']>,
  to: DeepReadonly<DecisionView['self']['position']>,
) => boolean;
