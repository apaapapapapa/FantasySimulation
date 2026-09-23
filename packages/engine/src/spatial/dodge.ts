import type { Cognition } from '@fantasy/domain/spatial';
import { add, cross, dot, length, mul, sub, unit, type Vec3 } from './math.ts';
import type { DecisionView } from './perception.ts';
import type { KnownClearance } from './assessment.ts';
import { resourceReady } from './locomotion.ts';

type Direction = Extract<Cognition, { kind: 'decision' }>['directions'][number];
export type DodgeOption = Direction & { goal: Vec3 };
/** Constant-velocity predictions use delayed visible samples, not live projectile trajectories. */
export function dodgeOptions(
  view: DecisionView,
  flight: boolean,
  clear: KnownClearance,
): DodgeOption[] {
  const observation = view.memory.observation;
  if (!observation?.projectiles.length) return [];
  const locomotion = view.self.actor.character.movement.locomotion;
  if (
    !resourceReady(view) ||
    (locomotion &&
      (view.resources.stamina ?? 0) <
        locomotion.dodgeStamina +
          Math.ceil(
            (flight
              ? (view.flightStaminaPerSecond ?? 0)
              : (locomotion.run.staminaPerMeter * locomotion.run.speedMmPerSecond) / 1000) * 0.1,
          ))
  )
    return [];
  const self = view.self,
    body = self.actor.character.body,
    movement = self.actor.character.movement;
  const speed =
    (((flight
      ? movement.flySpeedMmPerSecond
      : (locomotion?.run.speedMmPerSecond ?? movement.speedMmPerSecond)) /
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
  return directions.map(({ key, vector }) => {
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
    else if (view.canMove === false || !speed || !acceleration || reachable < distance)
      reason = 'insufficient movement or reaction time';
    else if (!clear(self.position, goal)) reason = 'known wall/floor/ceiling';
    else {
      const margin = Math.min(
        ...threats.map((t) => {
          const delta = sub(t.intercept, goal),
            halfSegment = (body.heightMm / 2 - body.radiusMm) / 1000;
          const y = Math.max(0, Math.abs(delta.y) - halfSegment);
          return (
            Math.sqrt(delta.x * delta.x + y * y + delta.z * delta.z) -
            body.radiusMm / 1000 -
            t.radius
          );
        }),
      );
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
