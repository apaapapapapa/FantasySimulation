import type { DecisionView, Gait } from '../state.ts';
import { length, sub } from '../math.ts';
import { postureRequiresWalk } from '../rules/posture.ts';
import { resourceReady } from '../rules/locomotion.ts';

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
