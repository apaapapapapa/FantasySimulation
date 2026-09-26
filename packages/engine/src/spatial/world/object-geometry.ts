import type { DeepReadonly, SpatialShape } from '@fantasy/domain/spatial/execution';
import type { Obstacle, Capsule } from '../geometry-types.ts';
import { IDENTITY, ZERO, add, length, mul, sub, type Vec3 } from '../math.ts';
import { rotation } from './terrain.ts';
import { rotate, capsuleOverlapsObstacle } from './geometry.ts';
import { capsuleShape, obstacleShape, CONTACT_TOLERANCE, type SpatialWorld } from './physics.ts';
export { obstacleShape } from './physics.ts';

export function objectGeometry(
  id: string,
  shape: DeepReadonly<SpatialShape>,
  position: Vec3,
): Obstacle {
  const blocks = { movement: true, vision: true, attack: true };
  if (shape.kind === 'box')
    return {
      id,
      position,
      blocks,
      halfExtents: mul(shape.sizeMm, 0.0005),
      rotation: rotation(shape.yawMilliDegrees, 0),
    };
  const r = shape.radiusMm / 1000;
  return {
    id,
    position,
    blocks,
    kind: shape.kind === 'sphere' ? 'sphere' : 'pillar',
    halfExtents: { x: r, y: shape.kind === 'sphere' ? r : shape.heightMm / 2000, z: r },
  };
}
export function shapeFits(obstacle: Obstacle, min: Vec3, max: Vec3): boolean {
  const h = obstacle.halfExtents;
  let extent = h;
  if (obstacle.rotation) {
    const x = rotate({ x: h.x, y: 0, z: 0 }, obstacle.rotation),
      y = rotate({ x: 0, y: h.y, z: 0 }, obstacle.rotation),
      z = rotate({ x: 0, y: 0, z: h.z }, obstacle.rotation);
    extent = {
      x: Math.abs(x.x) + Math.abs(y.x) + Math.abs(z.x),
      y: Math.abs(x.y) + Math.abs(y.y) + Math.abs(z.y),
      z: Math.abs(x.z) + Math.abs(y.z) + Math.abs(z.z),
    };
  }
  return (['x', 'y', 'z'] as const).every(
    (k) =>
      obstacle.position[k] - extent[k] >= min[k] - CONTACT_TOLERANCE &&
      obstacle.position[k] + extent[k] <= max[k] + CONTACT_TOLERANCE,
  );
}
/** One bounded convex query; touching support is legal, penetration is not. */
export function objectsOverlap(world: SpatialWorld, a: Obstacle, b: Obstacle): boolean {
  world.countCast();
  const contact = obstacleShape(a).contactShape(
    a.position,
    a.rotation ?? IDENTITY,
    obstacleShape(b),
    b.position,
    b.rotation ?? IDENTITY,
    0,
  );
  return !!contact && contact.distance < -CONTACT_TOLERANCE;
}
export function objectTouchesBody(
  world: SpatialWorld,
  object: Obstacle,
  position: Vec3,
  body: Capsule,
): boolean {
  world.countCast();
  return capsuleOverlapsObstacle(position, body, object);
}
/** Fixed orientation translation, against old geometry including occupied old follower poses. */
export function objectSweep(
  world: SpatialWorld,
  object: Obstacle,
  destination: Vec3,
  target: Obstacle,
  targetDestination = target.position,
): boolean {
  if (
    objectsOverlap(world, object, target) ||
    objectsOverlap(
      world,
      { ...object, position: destination },
      { ...target, position: targetDestination },
    )
  )
    return true;
  world.countCast();
  const hit = obstacleShape(object).castShape(
    object.position,
    object.rotation ?? IDENTITY,
    sub(destination, object.position),
    obstacleShape(target),
    target.position,
    target.rotation ?? IDENTITY,
    sub(targetDestination, target.position),
    0,
    1,
    false,
  );
  return !!hit && hit.time_of_impact < 1 - CONTACT_TOLERANCE;
}
export function objectSweepsBody(
  world: SpatialWorld,
  object: Obstacle,
  destination: Vec3,
  position: Vec3,
  body: Capsule,
): boolean {
  if (
    objectTouchesBody(world, object, position, body) ||
    objectTouchesBody(world, { ...object, position: destination }, position, body)
  )
    return true;
  world.countCast();
  const hit = obstacleShape(object).castShape(
    object.position,
    object.rotation ?? IDENTITY,
    sub(destination, object.position),
    capsuleShape(body),
    position,
    IDENTITY,
    ZERO,
    0,
    1,
    false,
  );
  return !!hit && hit.time_of_impact < 1 - CONTACT_TOLERANCE;
}
export function closestObjectPoint(obstacle: Obstacle, origin: Vec3): Vec3 {
  const q = obstacle.rotation,
    delta = sub(origin, obstacle.position),
    p = q ? rotate(delta, { x: -q.x, y: -q.y, z: -q.z, w: q.w }) : delta,
    h = obstacle.halfExtents;
  let closest: Vec3;
  if (obstacle.kind === 'sphere') {
    const distance = length(p);
    closest = distance > h.x ? mul(p, h.x / distance) : p;
  } else if (obstacle.kind === 'pillar') {
    const radial = Math.sqrt(p.x * p.x + p.z * p.z),
      scale = radial > h.x ? h.x / radial : 1;
    closest = { x: p.x * scale, y: Math.max(-h.y, Math.min(h.y, p.y)), z: p.z * scale };
  } else
    closest = {
      x: Math.max(-h.x, Math.min(h.x, p.x)),
      y: Math.max(-h.y, Math.min(h.y, p.y)),
      z: Math.max(-h.z, Math.min(h.z, p.z)),
    };
  return add(obstacle.position, q ? rotate(closest, q) : closest);
}
