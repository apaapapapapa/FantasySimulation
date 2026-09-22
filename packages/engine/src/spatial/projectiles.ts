import type { Budget, DeepReadonly, Definition, ProjectileDisplay } from '@fantasy/domain/spatial';
import { add, sub, mul, unit, length, turnToward, type Vec3 } from './math.ts';
import { at, ballShape, SpatialBudgetError, type SpatialWorld, type Trace } from './physics.ts';
import type { AbilityRevision } from './combat-state.ts';
import type { PerceptionMemory } from './perception.ts';
import type { MotionState } from './movement.ts';
import { bodyCapsule } from './terrain.ts';

export type ProjectileState = {
  id: string;
  ownerId: string;
  ability: AbilityRevision;
  cause: string;
  launchStep: number;
  position: Vec3;
  velocity: Vec3;
  attack: number;
  target: Vec3 | null;
};
const shapeOf = (p: ProjectileState) => {
  const shape = p.ability.definition.attack;
  if (shape.kind !== 'projectile') throw new Error('Invalid projectile instance');
  return shape;
};
export function displayProjectile(p: ProjectileState): ProjectileDisplay {
  const shape = shapeOf(p);
  return {
    id: p.id,
    ownerId: p.ownerId,
    abilityId: p.ability.id,
    position: { ...p.position },
    velocity: { ...p.velocity },
    radiusMm: shape.radiusMm,
    launchStep: p.launchStep,
    endStep: p.launchStep + shape.lifetimeSteps,
  };
}
/** Fixed-rule subdivision; the attempt budget only accepts or rejects it, never changes the trajectory. */
export function projectileCurve(
  p: ProjectileState,
  memory: PerceptionMemory,
  rules: DeepReadonly<Definition<'ruleset'>>,
  budget: Budget,
) {
  const shape = shapeOf(p),
    dt = 0.02,
    gravity = ((rules.gravityMmPerSecond2 / 1000) * shape.gravityScaleBps) / 10000;
  const target =
    shape.observation === 'launch-only' ? p.target : (memory.observation?.enemy?.position ?? null);
  const angularSpeed = target
    ? ((shape.homingTurnMilliDegreesPerSecond / 1000) * Math.PI) / 180
    : 0;
  const accelerationBound =
    Math.abs(gravity) + 2 * (length(p.velocity) + Math.abs(gravity) * dt) * angularSpeed;
  const pieces = Math.max(
    1,
    Math.ceil(Math.sqrt((accelerationBound * dt * dt) / ((8 * rules.curveErrorMm) / 1000))),
  );
  if (pieces > budget.maxCurveSegments) throw new SpatialBudgetError('curve-segments');
  const seconds = dt / pieces,
    trace: Trace = [];
  let position = { ...p.position },
    velocity = { ...p.velocity };
  for (let i = 0; i < pieces; i++) {
    const speed = length(velocity),
      desired = target ? sub(target, position) : velocity;
    const angle = target ? (shape.homingTurnMilliDegreesPerSecond / 1000) * seconds : 0;
    const midpoint =
      target && angle > 0 ? mul(turnToward(velocity, desired, angle / 2), speed) : velocity;
    const turned =
      target && angle > 0 ? mul(turnToward(velocity, desired, angle), speed) : velocity;
    const end = add(add(position, mul(midpoint, seconds)), {
      x: 0,
      y: (gravity * seconds * seconds) / 2,
      z: 0,
    });
    trace.push({ start: position, end, from: i / pieces, to: (i + 1) / pieces });
    position = end;
    velocity = add(turned, { x: 0, y: gravity * seconds, z: 0 });
  }
  return { trace, next: { ...p, position, velocity, target: target ? { ...target } : null } };
}
export function clipProjectile(trace: Trace, time: number): Trace {
  const point = at(trace, time);
  const pieces = trace
    .filter((s) => s.from < time)
    .map((s) => (s.to <= time ? s : { ...s, end: point, to: time }));
  return pieces.length ? pieces : [{ start: point, end: point, from: 0, to: 0 }];
}
/** Exact sphere/capsule intersection, then five equal-weight visible samples with linear falloff. */
export function explosionCoverage(
  world: SpatialWorld,
  origin: Vec3,
  radius: number,
  target: MotionState,
  position: Vec3,
): number {
  if (radius <= 0) return 0;
  if (world.overlaps(origin, ballShape(0), 'attack')) return 0;
  const body = bodyCapsule(target.actor.character.body);
  const axis = {
    ...position,
    y: Math.max(position.y - body.halfHeight, Math.min(position.y + body.halfHeight, origin.y)),
  };
  const delta = sub(origin, axis),
    distance = length(delta);
  if (distance > radius + body.radius) return 0;
  const normal = unit(delta);
  const nearest = distance <= body.radius ? origin : add(axis, mul(normal, body.radius));
  const samples = [
    position,
    { ...position, y: position.y + body.halfHeight + body.radius },
    { ...position, y: position.y - body.halfHeight - body.radius },
    nearest,
    sub(axis, mul(normal, body.radius)),
  ];
  let coverage = 0;
  for (const point of samples) {
    const amount = Math.max(0, 1 - length(sub(point, origin)) / radius);
    if (amount > 0 && !world.occluded(origin, point, 'attack')) coverage += amount;
  }
  return Math.max(0, Math.min(10000, Math.floor(coverage * 2000)));
}
