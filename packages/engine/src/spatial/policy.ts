import { add, cross, dot, length, mul, sub, unit, ZERO, type Vec3 } from './math.ts';
import type { MotionIntent } from './movement.ts';
import { Navigator, type NavigationResult } from './navigation.ts';
import { conditionMatches, type DecisionView } from './perception.ts';

export type Decision = { abilityId: string | null; goal: Vec3 | null; facing: Vec3 };
/** No live opponent, hidden projectile, mutable definition or random stream reaches this function. */
export function choosePolicy(
  view: DecisionView,
  readyAbilities: ReadonlySet<string>,
  flight: boolean,
): Decision {
  const actor = view.self.actor,
    policy = actor.policy;
  const target = view.memory.observation?.enemy ?? view.memory.lastSeen;
  const toward = target ? sub(target.position, view.self.position) : { ...ZERO };
  const facing = length(toward) > 1e-12 ? unit(toward) : { ...view.self.facing };
  let abilityId: string | null = null;
  for (const priority of policy.priorities) {
    const ability = actor.abilities.find((a) => a.id === priority.abilityId)!;
    if (
      readyAbilities.has(ability.id) &&
      conditionMatches(priority.when, view) &&
      conditionMatches(ability.definition.condition, view) &&
      (ability.definition.target === 'self' || target)
    ) {
      abilityId = ability.id;
      break;
    }
  }
  let goal: Vec3 | null = null;
  const preferred = policy.preferredDistanceMm / 1000;
  if (target && policy.movement !== 'hold') {
    const distance = length(toward),
      direction = unit(toward);
    if (policy.movement === 'approach' && distance > preferred)
      goal = sub(target.position, mul(direction, preferred));
    else if (policy.movement === 'keep-distance' || policy.movement === 'evade') {
      if (distance > preferred + 0.1) goal = sub(target.position, mul(direction, preferred));
      else if (distance < preferred - 0.1)
        goal = sub(view.self.position, mul(direction, preferred - distance));
    }
  }
  if (policy.movement === 'evade') {
    let forward = unit({ ...facing, y: 0 });
    if (length(forward) < 1e-12) forward = { x: 1, y: 0, z: 0 };
    const right = cross(forward, { x: 0, y: 1, z: 0 });
    const projectiles = [...(view.memory.observation?.projectiles ?? [])].sort((a, b) => {
      const pa = sub(a.position, view.self.position),
        pb = sub(b.position, view.self.position);
      return (
        length(pa) - length(pb) ||
        dot(forward, pb) - dot(forward, pa) ||
        dot(right, pb) - dot(right, pa) ||
        pa.y - pb.y ||
        dot(forward, a.velocity) - dot(forward, b.velocity) ||
        a.velocity.y - b.velocity.y ||
        dot(right, a.velocity) - dot(right, b.velocity)
      );
    });
    const projectile = projectiles[0];
    if (projectile) {
      let sideways = unit(cross(projectile.velocity, { x: 0, y: 1, z: 0 }));
      const away = sub(view.self.position, projectile.position);
      if (length(sideways) < 1e-12) {
        sideways = unit({ ...away, y: 0 });
        if (length(sideways) < 1e-12) sideways = right;
      } else if (dot(sideways, away) < 0) sideways = mul(sideways, -1);
      goal = add(
        view.self.position,
        mul(
          sideways,
          Math.max(
            1,
            (actor.character.movement.speedMmPerSecond / 1000) *
              actor.character.perception.reactionSteps *
              0.02,
          ),
        ),
      );
    }
  }
  if (flight) goal = { ...(goal ?? view.self.position), y: policy.flightAltitudeMm / 1000 };
  return { abilityId, goal, facing };
}
export function steerPolicy(
  view: DecisionView,
  decision: Decision,
  navigator: Navigator,
  options: { flight: boolean; canMove: boolean; speedBps: number; maxPathNodes: number },
): { intent: MotionIntent; navigation: NavigationResult | null } {
  const navigation =
    decision.goal && options.canMove
      ? navigator.find(
          view.self.position,
          options.flight ? decision.goal : navigator.groundGoal(decision.goal),
          options.flight,
          options.maxPathNodes,
          view.self.actor.policy.jumpWhenBlocked,
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
    },
    navigation,
  };
}
