import type { AttackGeometry } from '@fantasy/domain/spatial/execution';
import type { Trace, Obstacle } from '../geometry-types.ts';
import type { MotionState } from '../state.ts';
import { add, dot, IDENTITY, mul, sub, unit, ZERO, type Vec3 } from '../math.ts';
import {
  at,
  traceBoundaries,
  capsuleShape,
  CONTACT_TOLERANCE,
  SpatialBudgetError,
  straight,
  type SpatialWorld,
  type PhysicsShape,
} from '../world/physics.ts';
import { bodyCapsule } from '../world/terrain.ts';
import { obstacleShape } from '../world/object-geometry.ts';
import { traceAttack, type AttackContact } from './attacks.ts';

export function areaContact(
  world: SpatialWorld,
  object: Obstacle,
  target: MotionState,
  trace: Trace,
): { time: number; point: Vec3 } | null {
  const body = bodyCapsule(target.actor.character.body),
    shape = capsuleShape(body);
  for (const piece of trace) {
    world.countCast();
    const overlap = shape.contactShape(
      piece.start,
      IDENTITY,
      obstacleShape(object),
      object.position,
      object.rotation ?? IDENTITY,
      CONTACT_TOLERANCE,
    );
    if (overlap && overlap.distance <= CONTACT_TOLERANCE)
      return { time: piece.from, point: { ...overlap.point1 } };
    const hit = shape.castShape(
      piece.start,
      IDENTITY,
      sub(piece.end, piece.start),
      obstacleShape(object),
      object.position,
      object.rotation ?? IDENTITY,
      ZERO,
      0,
      1,
      true,
    );
    if (hit) {
      const time = piece.from + (piece.to - piece.from) * hit.time_of_impact;
      return { time, point: add(at(trace, time), hit.witness1) };
    }
  }
  return null;
}
function beamRotation(direction: Vec3) {
  const d = unit(direction);
  if (d.y < -0.999999999) return { x: 1, y: 0, z: 0, w: 0 };
  const q = { x: d.z, y: 0, z: -d.x, w: 1 + d.y },
    norm = Math.sqrt(dot(q, q) + q.w * q.w);
  return { x: q.x / norm, y: 0, z: q.z / norm, w: q.w / norm };
}
/** Entry and exit of a translating convex beam/body overlap within one trace piece. */
function contactWindow(
  world: SpatialWorld,
  beam: PhysicsShape,
  rotation: ReturnType<typeof beamRotation>,
  start: Vec3,
  velocity: Vec3,
  shape: PhysicsShape,
  target: Vec3,
  targetVelocity: Vec3,
  targetRotation: { x: number; y: number; z: number; w: number } = IDENTITY,
): number[] {
  const times: number[] = [];
  for (const reverse of [false, true]) {
    world.countCast();
    const sign = reverse ? -1 : 1,
      p = reverse ? add(start, velocity) : start,
      q = reverse ? add(target, targetVelocity) : target;
    const overlap = beam.contactShape(p, rotation, shape, q, targetRotation, CONTACT_TOLERANCE);
    if (overlap && overlap.distance <= CONTACT_TOLERANCE) times.push(reverse ? 1 : 0);
    else {
      const hit = beam.castShape(
        p,
        rotation,
        mul(velocity, sign),
        shape,
        q,
        targetRotation,
        mul(targetVelocity, sign),
        0,
        1,
        true,
      );
      if (hit) times.push(reverse ? 1 - hit.time_of_impact : hit.time_of_impact);
    }
  }
  return times;
}
/** A fixed-direction segment follows every muzzle bend, with convex entry/exit partitioning. */
export function beamContact(
  world: SpatialWorld,
  owner: Trace,
  offset: Vec3,
  direction: Vec3,
  range: number,
  radius: number,
  target: MotionState,
  targetTrace: Trace,
  limit: number,
): { contact: AttackContact | null; geometry: AttackGeometry; walls: AttackContact[] } {
  const boundaries = traceBoundaries(owner, targetTrace);
  const half = mul(direction, range / 2),
    beam = capsuleShape({ halfHeight: range / 2, radius }),
    rotation = beamRotation(direction),
    body = capsuleShape(bodyCapsule(target.actor.character.body));
  const samples = new Set(boundaries),
    obstacles = world.obstacles('attack');
  for (let i = 1; i < boundaries.length; i++) {
    const from = boundaries[i - 1]!,
      to = boundaries[i]!,
      start = add(add(at(owner, from), offset), half),
      velocity = sub(at(owner, to), at(owner, from));
    const windows = [
      contactWindow(
        world,
        beam,
        rotation,
        start,
        velocity,
        body,
        at(targetTrace, from),
        sub(at(targetTrace, to), at(targetTrace, from)),
      ),
      ...obstacles.map((o) =>
        contactWindow(
          world,
          beam,
          rotation,
          start,
          velocity,
          obstacleShape(o),
          o.position,
          ZERO,
          o.rotation,
        ),
      ),
    ];
    for (const t of windows.flat()) {
      const time = from + t * (to - from);
      samples.add(time);
      if (time < to) samples.add(Math.min(to, time + CONTACT_TOLERANCE));
      if (samples.size > limit + 1) throw new SpatialBudgetError('curve-segments');
    }
  }
  const segments: Extract<AttackGeometry, { kind: 'ray' | 'sphere' }>['segments'] = [],
    walls: AttackContact[] = [];
  let contact: AttackContact | null = null;
  for (const time of [...samples].sort((a, b) => a - b)) {
    const center = at(owner, time),
      origin = add(center, offset),
      end = add(origin, mul(direction, range));
    const muzzle = world.raycast(center, origin, 'attack');
    const targetAt = { ...target, position: at(targetTrace, time) };
    const hit = muzzle
      ? {
          kind: 'wall' as const,
          time: 0,
          center: muzzle.point,
          point: muzzle.point,
          obstacleIds: [muzzle.obstacleId],
        }
      : traceAttack(
          world,
          straight(origin, end),
          radius,
          targetAt,
          straight(targetAt.position, targetAt.position),
        );
    segments.push({
      start: muzzle ? { ...muzzle.point } : origin,
      end: hit?.center ?? end,
      from: time,
      to: time,
    });
    if (hit?.kind === 'body' && !contact) contact = { ...hit, time };
    if (hit?.kind === 'wall') walls.push({ ...hit, time });
  }
  return {
    contact,
    walls,
    geometry: { kind: 'ray', radiusMm: Math.round(radius * 1000), segments },
  };
}
