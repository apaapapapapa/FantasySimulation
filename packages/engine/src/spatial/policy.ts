import {
  canonicalJson,
  compareIds,
  type CandidateAssessment,
  type Cognition,
} from '@fantasy/domain/spatial';
import { length, mul, sub, unit, ZERO, type Vec3 } from './math.ts';
import type { MotionIntent } from './movement.ts';
import { Navigator, type NavigationResult } from './navigation.ts';
import { conditionMatches, type DecisionView } from './perception.ts';
import { declarationCost, inObservedRange, payCost } from './attacks.ts';
import { copyPublicStatuses } from './status-observation.ts';
import { usesObservedConditions } from './observed-conditions.ts';
import { blockedBySilence } from './categories.ts';
import { assessAbility, type KnownClearance } from './assessment.ts';
import { dodgeOptions } from './dodge.ts';
import { chooseMovementSlot, dodgeAssessment, passiveAssessment } from './movement-choice.ts';
import { initialDecisionRandom, weightedChoice, type DecisionRandom } from './decision-random.ts';
import {
  canMaintainFlight,
  chooseGait,
  gaitProfile,
  resourceReady,
  type Gait,
} from './locomotion.ts';

export type Decision = {
  abilityId: string | null;
  goal: Vec3 | null;
  facing: Vec3;
  cognition?: Extract<Cognition, { kind: 'decision' }>;
  random?: DecisionRandom;
  gait?: Gait;
  dodge?: boolean;
};
export const isDodgeDecision = (decision: Decision) =>
  decision.dodge ?? decision.cognition?.selection === 'dodge';
function movementGoal(view: DecisionView, facing: Vec3, flight: boolean): Vec3 | null {
  const target = view.memory.observation?.enemy ?? view.memory.lastSeen,
    policy = view.self.actor.policy;
  let goal: Vec3 | null = null;
  if (target && policy.movement !== 'hold') {
    const toward = sub(target.position, view.self.position),
      distance = length(toward),
      direction = distance > 1e-12 ? unit(toward) : facing;
    const preferred = policy.preferredDistanceMm / 1000;
    if (distance > preferred + 0.1) goal = sub(target.position, mul(direction, preferred));
    else if (policy.movement !== 'approach' && distance < preferred - 0.1)
      goal = sub(view.self.position, mul(direction, preferred - distance));
  }
  if (flight) goal = { ...(goal ?? view.self.position), y: policy.flightAltitudeMm / 1000 };
  return goal;
}
/** Only self state, delayed observations and declared terrain knowledge reach evaluation. */
export function choosePolicy(
  view: DecisionView,
  readyAbilities: ReadonlySet<string>,
  flight: boolean,
  random: DecisionRandom = initialDecisionRandom(view.self.actor.participant.rngSeed),
  clear: KnownClearance = () => true,
): Decision {
  const simultaneous = view.rules?.slots === 'simultaneous-v1';
  const actor = view.self.actor,
    target = view.memory.observation?.enemy ?? view.memory.lastSeen;
  const toward = target ? sub(target.position, view.self.position) : { ...ZERO };
  const facing = length(toward) > 1e-12 ? unit(toward) : { ...view.self.facing };
  const candidates: CandidateAssessment[] = [],
    excluded: { abilityId: string; reason: string }[] = [];
  // Conditions form a set of admissible uses. Input enumeration and IDs confer no utility bonus.
  const abilities = [...actor.abilities].sort(
    (a, b) =>
      compareIds(canonicalJson(a.definition), canonicalJson(b.definition)) ||
      compareIds(a.id, b.id),
  );
  for (const ability of abilities) {
    const d = ability.definition;
    if (d.trigger !== 'action') continue;
    const enabled = actor.policy.priorities.some(
      (p) => p.abilityId === ability.id && conditionMatches(p.when, view),
    );
    const payment = payCost(
      d,
      view.resources,
      view.used?.[ability.id] ?? 0,
      !view.staminaExhausted,
    );
    const reason = view.incapacitated
      ? 'incapacitated'
      : view.canAct === false
        ? 'action-phase'
        : !readyAbilities.has(ability.id)
          ? 'cooldown'
          : !payment.ok
            ? `insufficient-${payment.reason}`
            : flight &&
                !canMaintainFlight(
                  payment.resources,
                  view.flightStaminaPerSecond ?? 0,
                  resourceReady(view),
                )
              ? 'flight-reserve'
              : view.silenced && blockedBySilence(d)
                ? 'silenced'
                : !enabled || !conditionMatches(d.condition, view)
                  ? 'condition'
                  : !actor.character.stats.actionSpeedBps
                    ? 'action-speed'
                    : !inObservedRange(d, view)
                      ? 'observed-range-or-facing'
                      : null;
    if (reason) {
      excluded.push({ abilityId: ability.id, reason });
      continue;
    }
    const assessment = assessAbility(view, ability);
    if (assessment.weight) candidates.push(assessment);
    else excluded.push({ abilityId: ability.id, reason: 'no estimated benefit' });
  }
  let directions = dodgeOptions(view, flight, clear);
  if (!simultaneous && directions.some((d) => d.weight > 0)) candidates.push(dodgeAssessment(view));
  let goal = movementGoal(view, facing, flight);
  if (!candidates.length) candidates.push(passiveAssessment(!!goal));
  const choice = weightedChoice(
      candidates.map((c) => c.weight),
      random.action,
    ),
    selected = candidates[choice.index!]!;
  for (const candidate of candidates) candidate.totalWeight = choice.total;
  const draws: Extract<Cognition, { kind: 'decision' }>['draws'] = [
    {
      purpose: 'action',
      before: random.action,
      after: choice.state,
      draws: choice.draws,
      selection: selected.key,
    },
  ];
  const nextRandom = { ...random, action: choice.state };
  const ability = actor.abilities.find((a) => a.id === selected.abilityId);
  const movement =
    simultaneous && view.memory.observation?.projectiles.length
      ? chooseMovementSlot(view, ability, flight, !!goal, random.movement, clear)
      : undefined;
  const dodge = movement?.dodge ?? selected.kind === 'dodge';
  if (movement) {
    directions = movement.directions;
    nextRandom.movement = movement.random;
  }
  if (dodge) {
    const direction = weightedChoice(
        directions.map((d) => d.weight),
        random.dodge,
      ),
      selectedDirection = directions[direction.index!]!;
    goal = selectedDirection.goal;
    nextRandom.dodge = direction.state;
    draws.push({
      purpose: 'dodge',
      before: random.dodge,
      after: direction.state,
      draws: direction.draws,
      selection: selectedDirection.key,
    });
  }
  const observation = view.memory.observation;
  const allocation = chooseGait(
    view,
    ability ? (declarationCost(ability.definition).stamina ?? 0) : 0,
    dodge,
  );
  return {
    abilityId: selected.abilityId,
    ...(movement ? { dodge } : {}),
    goal,
    facing,
    random: nextRandom,
    ...(allocation ? { gait: dodge ? ('run' as const) : allocation.gait } : {}),
    cognition: {
      kind: 'decision',
      ...(movement ? { movementSlot: movement.cognition } : {}),
      perspective: 'subjective',
      ...(allocation
        ? {
            locomotion: {
              ...allocation,
              gait: dodge ? ('run' as const) : allocation.gait,
              stamina: view.resources.stamina ?? 0,
              exhausted: !resourceReady(view),
            },
          }
        : {}),
      sampledAt: observation?.sampledAt ?? null,
      availableAt: observation?.availableAt ?? null,
      targetId: target?.id ?? null,
      targetObservedAt: target?.step ?? null,
      targetAvailableAt: target ? target.step + actor.character.perception.reactionSteps : null,
      appearance: target?.appearance
        ? { ...target.appearance, equipment: [...target.appearance.equipment] }
        : null,
      wounds: target?.wounds ?? 'unknown',
      ...(target?.stage ? { observedStage: { ...target.stage } } : {}),
      ...(target?.statuses && { observedStatuses: copyPublicStatuses(target.statuses) }),
      ...(observation?.enemy &&
        (actor.abilities.some((a) =>
          [
            a.definition.condition,
            ...(a.definition.stages?.flatMap((s) => [s.startCondition, s.interruptWhen]) ?? []),
          ].some((c) => c && usesObservedConditions(c)),
        ) ||
          actor.policy.priorities.some((p) => usesObservedConditions(p.when))) && {
          conditionObservation: {
            phase: observation.enemy.action ?? null,
            facingBps: {
              x: Math.round(observation.enemy.facing.x * 10000),
              y: Math.round(observation.enemy.facing.y * 10000),
              z: Math.round(observation.enemy.facing.z * 10000),
            },
          },
        }),
      targetPositionMm: target
        ? {
            x: Math.round(target.position.x * 1000),
            y: Math.round(target.position.y * 1000),
            z: Math.round(target.position.z * 1000),
          }
        : null,
      observedProjectiles: (observation?.projectiles ?? []).map((p) => p.id).sort(compareIds),
      terrain: view.memory.terrain.map((s) => ({
        ...s,
        pointMm: { ...s.pointMm },
        normalBps: { ...s.normalBps },
      })),
      candidates,
      excluded,
      selection: selected.key,
      method:
        candidates.length === 1
          ? 'sole'
          : candidates.every((c) => c.weight === candidates[0]!.weight)
            ? 'equal'
            : selected.exploration > 0
              ? 'exploration'
              : 'weighted',
      draws,
      directions: directions.map(({ key, weight, reason }) => ({ key, weight, reason })),
    },
  };
}
export function steerPolicy(
  view: DecisionView,
  decision: Decision,
  navigator: Navigator,
  options: { flight: boolean; canMove: boolean; speedBps: number; maxPathNodes: number },
): { intent: MotionIntent; navigation: NavigationResult | null } {
  const character = view.self.actor.character,
    movement = character.movement.locomotion,
    ability = view.self.actor.abilities.find((a) => a.id === decision.abilityId);
  const stamina = Math.max(
    0,
    (view.resources.stamina ?? 0) -
      (ability ? (declarationCost(ability.definition).stamina ?? 0) : 0) -
      (isDodgeDecision(decision) ? (movement?.dodgeStamina ?? 0) : 0),
  );
  const ready = resourceReady({ ...view, resources: { ...view.resources, stamina } });
  const gait = ready ? (decision.gait ?? 'walk') : 'slow';
  const profile = gaitProfile(character, gait);
  const speed = options.flight ? character.movement.flySpeedMmPerSecond : profile.speedMmPerSecond;
  const resources =
    movement || character.stamina || (view.flightStaminaPerSecond ?? 0) > 0
      ? {
          speedMmPerSecond: (speed * options.speedBps) / 10000,
          stamina,
          ready,
          walkPerMeter: profile.staminaPerMeter,
          jumpStamina: movement?.jumpStamina ?? 0,
          stepPerMeter: movement?.stepStaminaPerMeter ?? 0,
          flightPerSecond: view.flightStaminaPerSecond ?? 0,
        }
      : undefined;
  const navigation =
    decision.goal && options.canMove
      ? navigator.find(
          view.self.position,
          options.flight ? decision.goal : navigator.groundGoal(decision.goal),
          options.flight,
          options.maxPathNodes,
          view.self.actor.policy.jumpWhenBlocked,
          resources,
        )
      : null;
  const first =
    navigation?.kind === 'path'
      ? navigation.waypoints.find((w) => length(sub(w.position, view.self.position)) > 0.05)
      : undefined;
  return {
    intent: {
      direction: first ? unit(sub(first.position, view.self.position)) : { ...ZERO },
      facing: decision.facing,
      jump: !!first && first.mode === 'jump' && view.self.actor.policy.jumpWhenBlocked,
      flight: options.flight,
      canMove: options.canMove,
      speedBps: options.speedBps,
      ...(movement && !options.flight ? { speedMmPerSecond: profile.speedMmPerSecond } : {}),
    },
    navigation,
  };
}
