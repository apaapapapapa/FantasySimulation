import type { DecisionView } from '../state.ts';
import {
  matchAttack,
  type AttackHandlers,
  type AttackVariant,
  type DeepReadonly,
  type Stage,
} from '@fantasy/domain/spatial/execution';
import { relocationDestination } from '../rules/relocation.ts';
import { objectGeometry } from '../world/object-geometry.ts';
import { capsuleObstacleContact } from '../world/geometry.ts';
import { bodyCapsule } from '../world/terrain.ts';
import { bodyPoint } from '../world/visibility.ts';
import { bladePose } from '../rules/blades.ts';
import { dot, length, mul, sub } from '../math.ts';

const shapeHandlers: AttackHandlers<DecisionView, number> = {
  area: (shape, view) => {
    const target = view.memory.observation?.enemy;
    const position = relocationDestination(shape.placement, view.self, target);
    if (
      !position ||
      !target ||
      length(sub(position, view.self.position)) > shape.placement.maxDistanceMm / 1000
    )
      return 0;
    const body = target.size
      ? bodyCapsule({ ...view.self.actor.character.body, ...target.size })
      : { radius: 0.3, halfHeight: 0.6 };
    const gap = capsuleObstacleContact(
      target.position,
      body,
      objectGeometry('estimate', shape.shape, position),
    ).distance;
    const uncertainty =
      length(target.velocity) *
      (shape.armDelaySteps + view.self.actor.character.perception.reactionSteps) *
      0.02;
    return gap <= 0 ? 0.85 / (1 + uncertainty) : 0.2 / (1 + gap + uncertainty);
  },
  beam: (shape, view) => {
    const target = view.memory.observation?.enemy ?? view.memory.lastSeen;
    if (!target) return 0.2;
    const radius = (shape.radiusMm + (target.size?.radiusMm ?? 300)) / 1000;
    const drift =
      length(target.velocity) * view.self.actor.character.perception.reactionSteps * 0.02;
    return Math.max(0.15, (0.9 * radius) / (radius + drift));
  },
  direct: () => 1,
  hitscan: () => 1,
  projectile: (_shape, view) =>
    view.memory.deflections?.some(
      (d) =>
        d.targetId === (view.memory.observation?.enemy ?? view.memory.lastSeen)?.id &&
        d.availableAt <= view.step &&
        d.expiresAt > view.step,
    )
      ? 0.5
      : 1,
  melee: () => 1,
  arc: (shape, view) => bladeEstimate(view, shape),
  radial: (shape, view) => bladeEstimate(view, shape),
};
/** Own geometry and delayed visible size/position only. An estimate never guarantees contact. */
export function shapeEstimate(view: DecisionView, attack: AttackVariant) {
  return matchAttack(attack, shapeHandlers, view);
}
function bladeEstimate(view: DecisionView, attack: AttackVariant<'arc' | 'radial'>) {
  const target = view.memory.observation?.enemy ?? view.memory.lastSeen;
  if (!target) return 0.25;
  const root = bodyPoint(view.self, view.self.actor.character.body.muzzleOffset);
  const sweep = (attack.kind === 'radial' ? 360000 : attack.sweepMilliDegrees) / 1000;
  let distance = Infinity;
  for (let sample = 0; sample <= 24; sample++) {
    const pose = bladePose(
      root,
      view.self.facing,
      attack.reachMm / 1000,
      attack.startAngleMilliDegrees / 1000 + (sweep * sample) / 24,
    );
    const shaft = sub(pose.tip, root),
      delta = sub(target.position, root);
    const nearest = mul(shaft, Math.max(0, Math.min(1, dot(delta, shaft) / dot(shaft, shaft))));
    distance = Math.min(distance, length(sub(delta, nearest)));
  }
  const extent = (attack.bladeRadiusMm + (target.size?.radiusMm ?? 300)) / 1000;
  return distance <= extent + 0.2 ? 0.95 : distance <= extent + 1 ? 0.6 : 0.2;
}
export function stageMotionEstimate(view: DecisionView, stage: DeepReadonly<Stage>) {
  const motion = stage.selfMotion;
  if (!motion) return { feasible: true, jumpCost: 0, exposure: 0 };
  const jumpCost =
    motion.kind === 'leap' ? (view.self.actor.character.movement.locomotion?.jumpStamina ?? 0) : 0;
  const travel = Math.min(
    (motion.speedMmPerSecond / 1000) * stage.durationSteps * 0.02,
    ((motion.accelerationMmPerSecond2 / 1000) * (stage.durationSteps * 0.02) ** 2) / 2 +
      length(view.self.velocity) * stage.durationSteps * 0.02,
  );
  return {
    feasible:
      motion.kind !== 'leap' ||
      (view.canMove !== false && view.self.grounded && !view.staminaExhausted),
    jumpCost,
    exposure: Math.min(0.5, travel / 20),
  };
}
