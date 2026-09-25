import type { DecisionView, StatusCohort, Gait } from './state.ts';
export type { Gait } from './state.ts';
import type { DeepReadonly, Definition, ResourceState } from '@fantasy/domain/spatial/execution';
import { staminaExhausted } from './resources.ts';
import { length, sub } from './math.ts';
import { postureRequiresWalk } from './posture.ts';

export function gaitProfile(character: DeepReadonly<Definition<'character'>>, gait: Gait) {
  const m = character.movement;
  if (!m.locomotion)
    return {
      speedMmPerSecond:
        character.stamina && gait === 'slow' ? m.speedMmPerSecond / 4 : m.speedMmPerSecond,
      staminaPerMeter: 0,
    };
  return gait === 'slow'
    ? { speedMmPerSecond: m.locomotion.exhaustedSpeedMmPerSecond, staminaPerMeter: 0 }
    : m.locomotion[gait];
}
/** Competing flight grants offer alternatives; omitted cost is a free grant. */
export function flightRate(statuses: readonly StatusCohort[], step: number): number {
  const grants = statuses.filter(
    (s) => s.startStep <= step && step < s.endStep && s.revision.definition.modifiers.flight,
  );
  return grants.length
    ? Math.min(
        ...grants.map(
          (s) => s.flightStaminaPerSecond ?? s.revision.definition.flightStaminaPerSecond ?? 0,
        ),
      )
    : 0;
}
export function resourceReady(view: Pick<DecisionView, 'resources' | 'self' | 'staminaExhausted'>) {
  return !staminaExhausted(
    view.resources,
    view.self.actor.character.stamina,
    view.staminaExhausted,
  );
}
export function canMaintainFlight(
  resources: ResourceState,
  perSecond: number,
  ready: boolean,
  elapsedMs = 20,
) {
  return (
    perSecond === 0 ||
    (ready && (resources.stamina ?? 0) >= Math.ceil((perSecond * elapsedMs) / 1000))
  );
}
/** Preserve a near-term skill, emergency dodge and requested jump before choosing a gait. */
export function chooseGait(view: DecisionView, selectedCost: number, dodge = false) {
  const character = view.self.actor.character,
    m = character.movement.locomotion;
  if (!m) return undefined;
  const stamina = view.resources.stamina ?? 0;
  const skills = view.self.actor.abilities
    .filter(
      (a) =>
        a.definition.trigger === 'action' &&
        (a.definition.costs.stamina ?? 0) > 0 &&
        (!a.definition.costs.uses || (view.used[a.id] ?? 0) < a.definition.costs.uses) &&
        a.definition.costs.mp <= view.resources.mp &&
        a.definition.costs.hp <= view.resources.hp,
    )
    .map((a) => a.definition.costs.stamina ?? 0);
  const futureSkill = skills.length ? Math.min(...skills) : 0;
  const reserve =
    selectedCost +
    (dodge
      ? m.dodgeStamina
      : Math.max(
          futureSkill,
          view.memory.observation?.projectiles.length ? m.dodgeStamina : 0,
          view.self.actor.policy.jumpWhenBlocked ? m.jumpStamina : 0,
        ));
  const horizon = view.rules.horizonSteps * 0.02;
  const runCost = Math.ceil(
    (((m.run.staminaPerMeter * m.run.speedMmPerSecond) / 1000) * horizon * view.speedBps) / 10000,
  );
  const target = view.memory.observation?.enemy ?? view.memory.lastSeen;
  const policy = view.self.actor.policy;
  const distance = target ? length(sub(target.position, view.self.position)) : null;
  const preferred = policy.preferredDistanceMm / 1000;
  const urgent =
    dodge ||
    !!view.memory.observation?.projectiles.length ||
    (policy.movement !== 'hold' &&
      distance !== null &&
      (distance > preferred + 0.1 ||
        (policy.movement !== 'approach' && distance < preferred - 0.1)));
  const gait: Gait = !resourceReady(view)
    ? 'slow'
    : !postureRequiresWalk(view.self) && urgent && stamina - reserve >= runCost
      ? 'run'
      : 'walk';
  return { gait, reserveStamina: reserve };
}
