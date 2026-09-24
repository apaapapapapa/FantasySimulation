import type { DeepReadonly, Definition, Stage } from '@fantasy/domain/spatial/execution';
import type { DecisionView } from './perception.ts';
import { bodyPoint } from './perception.ts';
import { bladePose } from './blades.ts';
import { dot, length, mul, sub } from './math.ts';

/** Own geometry and delayed visible size/position only. A coarse estimate never guarantees contact. */
export function shapeEstimate(
  view: DecisionView,
  attack: DeepReadonly<Definition<'ability'>['attack']>,
) {
  if (attack.kind !== 'arc' && attack.kind !== 'radial') return 1;
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
