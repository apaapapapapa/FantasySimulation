import type {
  Cognition,
  Posture,
  Definition,
  DeepReadonly,
} from '@fantasy/domain/spatial/execution';
import { add, cross, dot, length, mul, sub, unit, type Vec3 } from './math.ts';
import type { DecisionView } from './perception.ts';
import type { KnownClearance } from './assessment.ts';
import { resourceReady } from './locomotion.ts';
import { postureBody, postureDuration, posturePosition, postureRequiresWalk } from './posture.ts';

type Direction = Extract<Cognition, { kind: 'decision' }>['directions'][number];
export type DodgeOption = Direction & {
  goal: Vec3;
  jump?: boolean;
  posture?: Posture;
  postureUntil?: number;
};
/** Constant-velocity predictions use delayed visible samples, not live projectile trajectories. */
export function dodgeOptions(
  view: DecisionView,
  flight: boolean,
  clear: KnownClearance,
): DodgeOption[] {
  const observation = view.memory.observation;
  if (!observation?.projectiles.length) return [];
  const locomotion = view.self.actor.character.movement.locomotion;
  const gait = postureRequiresWalk(view.self) ? locomotion?.walk : locomotion?.run;
  if (
    !resourceReady(view) ||
    (locomotion && (view.resources.stamina ?? 0) < locomotion.dodgeStamina)
  )
    return [];
  const travelAffordable =
    !locomotion ||
    (view.resources.stamina ?? 0) >=
      locomotion.dodgeStamina +
        Math.ceil(
          (flight
            ? (view.flightStaminaPerSecond ?? 0)
            : (gait!.staminaPerMeter * gait!.speedMmPerSecond) / 1000) * 0.1,
        );
  if (!travelAffordable && (flight || !view.rules?.groundEvasion)) return [];
  const self = view.self,
    body = self.actor.character.body,
    movement = self.actor.character.movement;
  const speed =
    (((flight
      ? movement.flySpeedMmPerSecond
      : (gait?.speedMmPerSecond ?? movement.speedMmPerSecond)) /
      1000) *
      (view.speedBps ?? 10000)) /
    10000;
  const acceleration = movement.accelerationMmPerSecond2 / 1000;
  const age = Math.max(0, (view.step ?? observation.availableAt) - observation.sampledAt) * 0.02;
  const horizon = (view.rules?.horizonSteps ?? 50) * 0.02;
  const threats = observation.projectiles.flatMap((p) => {
    const position = add(p.position, mul(p.velocity, age)),
      relative = sub(self.position, position),
      vv = dot(p.velocity, p.velocity);
    if (vv < 1e-12) return [];
    const time = dot(relative, p.velocity) / vv;
    const intercept = add(position, mul(p.velocity, time));
    if (
      time <= 0 ||
      time > horizon ||
      length(sub(intercept, self.position)) > body.heightMm / 2000 + speed * time
    )
      return [];
    return [{ time, intercept, radius: (p.radiusMm ?? 80) / 1000 }];
  });
  if (!threats.length) return [];
  const time = Math.min(...threats.map((t) => t.time));
  let forward = unit({ ...self.facing, y: 0 });
  if (length(forward) < 1e-12) forward = { x: 1, y: 0, z: 0 };
  const right = cross(forward, { x: 0, y: 1, z: 0 });
  const directions: { key: Direction['key']; vector: Vec3 }[] = [
    { key: 'up', vector: { x: 0, y: 1, z: 0 } },
    { key: 'down', vector: { x: 0, y: -1, z: 0 } },
    { key: 'left', vector: mul(right, -1) },
    { key: 'right', vector: right },
  ];
  const marginAt = (goal: Vec3, shape: DeepReadonly<Definition<'character'>['body']>) =>
    Math.min(
      ...threats.map((t) => {
        const delta = sub(t.intercept, goal),
          half = (shape.heightMm / 2 - shape.radiusMm) / 1000;
        return (
          Math.sqrt(delta.x ** 2 + Math.max(0, Math.abs(delta.y) - half) ** 2 + delta.z ** 2) -
          shape.radiusMm / 1000 -
          t.radius
        );
      }),
    );
  return directions.map(({ key, vector }) => {
    if (vector.y && !flight && view.rules?.groundEvasion) {
      if (view.canMove === false || !self.grounded)
        return { key, goal: self.position, weight: 0, reason: 'ground movement unavailable' };
      if (key === 'up') {
        const velocity = movement.jumpMmPerSecond / 1000,
          gravity = (view.gravityMmPerSecond2 ?? -9807) / 1000;
        const height = velocity * time + (gravity * time * time) / 2;
        const goal = add(self.position, { x: 0, y: height, z: 0 });
        const peak = gravity < 0 ? (velocity * velocity) / (-2 * gravity) : 0;
        const affordable =
          !locomotion ||
          (view.resources.stamina ?? 0) >= locomotion.dodgeStamina + locomotion.jumpStamina;
        const margin = marginAt(goal, body);
        const allowed =
          self.posture?.current !== 'prone' &&
          !self.posture?.transition &&
          velocity > 0 &&
          gravity < 0 &&
          height > 0 &&
          margin > 0 &&
          affordable &&
          clear(self.position, add(self.position, { x: 0, y: peak, z: 0 }));
        return {
          key,
          goal: { ...self.position },
          jump: allowed,
          weight: allowed ? Math.max(1, Math.round(margin * 1000)) : 0,
          reason: allowed
            ? 'ballistic jump from observed intercept'
            : 'jump timing, ceiling, posture or resource constraint',
        };
      }
      for (const posture of ['crouching', 'prone'] as const) {
        if (self.posture?.transition && self.posture.transition.to !== posture) continue;
        const shape = postureBody(self, posture);
        if (!shape || postureDuration(self, posture) * 0.02 >= time) continue;
        const position = posturePosition(self, shape),
          margin = marginAt(position, shape);
        if (margin > 0 && clear(position, position, shape))
          return {
            key,
            goal: self.position,
            posture,
            postureUntil: (view.step ?? 0) + Math.ceil(time * 50) + 1,
            weight: Math.max(1, Math.round(margin * 1000)),
            reason: 'lower capsule before observed intercept',
          };
      }
      return {
        key,
        goal: self.position,
        weight: 0,
        reason: 'no timely posture with physical clearance',
      };
    }
    const extent = (vector.y ? body.heightMm / 2 : body.radiusMm) / 1000;
    const distance = extent + Math.max(...threats.map((t) => t.radius)) + 0.1;
    const goal = add(self.position, mul(vector, distance));
    let reason = 'observed threat; physically reachable clearance';
    const initial = Math.max(-speed, Math.min(speed, dot(self.velocity, vector)));
    const ramp = acceleration
      ? Math.max(0, Math.min(time, (speed - initial) / acceleration))
      : time;
    const reachable = initial * ramp + 0.5 * acceleration * ramp * ramp + speed * (time - ramp);
    if (vector.y && !flight) reason = 'no vertical movement ability';
    else if (
      !travelAffordable ||
      view.canMove === false ||
      !speed ||
      !acceleration ||
      reachable < distance
    )
      reason = 'insufficient movement or reaction time';
    else if (!clear(self.position, goal)) reason = 'known wall/floor/ceiling';
    else {
      const margin = marginAt(goal, body);
      if (margin > 0)
        return {
          key,
          goal,
          weight: Math.max(1, Math.min(10000, Math.round(margin * 1000))),
          reason,
        };
      reason = 'another observed threat crosses this escape';
    }
    return { key, goal, weight: 0, reason };
  });
}
