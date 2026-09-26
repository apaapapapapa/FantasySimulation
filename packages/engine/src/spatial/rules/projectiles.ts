import type { Trace } from '../geometry-types.ts';
import type { AbilityRevision, PerceptionMemory, MotionState, DamageSnapshot } from '../state.ts';
import type {
  Budget,
  DeepReadonly,
  Definition,
  ProjectileDisplay,
  ProjectileDeflection,
  Stage,
  StageContact,
} from '@fantasy/domain/spatial/execution';
import { add, sub, mul, unit, length, turnToward, type Vec3 } from '../math.ts';
import { ballShape, SpatialBudgetError, type SpatialWorld } from '../world/physics.ts';
import { bodyCapsule } from '../world/terrain.ts';

export type ProjectileState = DamageSnapshot & {
  id: string;
  ownerId: string;
  ability: AbilityRevision;
  cause: string;
  launchStep: number;
  position: Vec3;
  velocity: Vec3;
  target: Vec3 | null;
  deflection?: ProjectileDeflection;
  stage?: StageContact;
  hit?: DeepReadonly<Stage['hit']>;
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
    ...(p.deflection ? { deflection: p.deflection } : {}),
    ...(p.stage ? { stage: p.stage } : {}),
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
  const target = p.deflection
    ? null
    : shape.observation === 'launch-only'
      ? p.target
      : (memory.observation?.enemy?.position ?? null);
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
  const velocities: { from: number; to: number; start: Vec3; end: Vec3 }[] = [];
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
    const nextVelocity = add(turned, { x: 0, y: gravity * seconds, z: 0 });
    velocities.push({ from: i / pieces, to: (i + 1) / pieces, start: velocity, end: nextVelocity });
    velocity = nextVelocity;
  }
  return {
    trace,
    next: { ...p, position, velocity, target: target ? { ...target } : null },
    velocities,
  };
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

export function projectileVelocityAt(curve: ReturnType<typeof projectileCurve>, time: number) {
  const sample = curve.velocities.find((v) => time <= v.to)!;
  return add(
    sample.start,
    mul(sub(sample.end, sample.start), (time - sample.from) / (sample.to - sample.from)),
  );
}

export function projectileEventSource(p: ProjectileState) {
  return {
    entityId: p.id,
    actorId: p.ownerId,
    abilityId: p.ability.id,
    ...(p.deflection
      ? { sourceActorId: p.deflection.originalOwnerId, sourceProjectileId: p.id }
      : {}),
  };
}
