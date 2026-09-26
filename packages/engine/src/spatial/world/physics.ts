import {
  blocksQuery,
  type Trace,
  type Capsule,
  type Obstacle,
  type Layer,
  type SpatialQuery,
} from '../geometry-types.ts';
export type { Segment, Trace, Capsule, Obstacle, Layer } from '../geometry-types.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import { canonicalJson, type MotionProjection } from '@fantasy/domain/spatial/execution';
export type { MotionProjection } from '@fantasy/domain/spatial/execution';
import {
  capsuleOverlapsObstacle,
  capsuleObstacleContact,
  faceNormal,
  planarContactTime,
  rotate,
} from './geometry.ts';
import { add, dot, IDENTITY, length, lerp, mul, sub, unit, ZERO, type Vec3 } from '../math.ts';

let ready: Promise<void> | undefined;
export async function initializePhysics(): Promise<void> {
  await (ready ??= RAPIER.init());
}
type SweepHit = { time_of_impact: number; normal1: Vec3; obstacleId: string };
export const COLLISION_SKIN = 0.002;
export const CONTACT_TOLERANCE = 1e-6;
export function firstImpact(wall: number | undefined, body: number | undefined) {
  if (wall !== undefined && (body === undefined || wall <= body + CONTACT_TOLERANCE))
    return { kind: 'wall' as const, time: wall };
  return body === undefined ? undefined : { kind: 'body' as const, time: body };
}
export class SpatialBudgetError extends Error {
  readonly resource: string;
  readonly details?: { observed: number; limit: number; cause: string };
  constructor(resource: string, detail?: string, details?: SpatialBudgetError['details']) {
    super(`Spatial budget exceeded: ${resource}${detail ? `; ${detail}` : ''}`);
    this.resource = resource;
    if (details) this.details = details;
  }
}

export function at(trace: Trace, time: number): Vec3 {
  const segment = trace.find((piece) => piece.to >= time) ?? trace.at(-1);
  if (!segment) throw new Error('Empty movement trace');
  return segment.to === segment.from
    ? segment.end
    : lerp(
        segment.start,
        segment.end,
        Math.max(0, Math.min(1, (time - segment.from) / (segment.to - segment.from))),
      );
}
export const straight = (start: Vec3, end: Vec3): Trace => [{ start, end, from: 0, to: 1 }];
/** Keep only the emitted path up to contact, without a synthetic stationary tail. */
export function clipTrace(trace: Trace, time: number): Trace {
  const point = at(trace, time);
  const pieces = trace
    .filter((s) => s.from < time)
    .map((s) => (s.to <= time ? s : { ...s, end: point, to: time }));
  return pieces.length ? pieces : [{ start: point, end: point, from: 0, to: 0 }];
}
export function stopAt(trace: Trace, time: number): Trace {
  const end = at(trace, time);
  const result = trace
    .filter((piece) => piece.from < time)
    .map((piece) => (piece.to <= time ? piece : { ...piece, end, to: time }));
  if (time < 1 || !result.length) result.push({ start: end, end, from: time, to: 1 });
  return result;
}

/** Continuous relative motion over every pair of overlapping piecewise-linear segments. */
function extent(shape: RAPIER.Shape): Vec3 | undefined {
  if (shape instanceof RAPIER.Ball) return { x: shape.radius, y: shape.radius, z: shape.radius };
  if (shape instanceof RAPIER.Capsule)
    return { x: shape.radius, y: shape.radius + shape.halfHeight, z: shape.radius };
  return undefined;
}
function capsuleDimensions(shape: RAPIER.Shape) {
  if (shape instanceof RAPIER.Ball) return { radius: shape.radius, halfHeight: 0 };
  if (shape instanceof RAPIER.Capsule)
    return { radius: shape.radius, halfHeight: shape.halfHeight };
  return undefined;
}
/** Exact sweep against the Minkowski sum of two upright capsules, including spherical caps. */
function capsuleTime(
  p: Vec3,
  v: Vec3,
  radius: number,
  halfHeight: number,
  duration: number,
  includeInitialContact: boolean,
) {
  const nearest = { x: p.x, y: p.y - Math.max(-halfHeight, Math.min(halfHeight, p.y)), z: p.z };
  if (dot(nearest, nearest) <= (radius + CONTACT_TOLERANCE) ** 2)
    return includeInitialContact || dot(nearest, v) < -1e-12 ? 0 : undefined;
  let first: number | undefined;
  function roots(q: Vec3, velocity: Vec3, accepts: (time: number) => boolean) {
    const a = dot(velocity, velocity),
      b = dot(q, velocity),
      c = dot(q, q) - radius * radius;
    if (a < 1e-24) return;
    const discriminant = b * b - a * c;
    if (discriminant < 0) return;
    const time = (-b - Math.sqrt(discriminant)) / a;
    if (time >= 0 && time <= duration && (first === undefined || time < first) && accepts(time))
      first = time;
  }
  roots(
    { x: p.x, y: 0, z: p.z },
    { x: v.x, y: 0, z: v.z },
    (t) => Math.abs(p.y + v.y * t) <= halfHeight,
  );
  for (const sign of [-1, 1])
    roots(
      { x: p.x, y: p.y - sign * halfHeight, z: p.z },
      v,
      (t) => sign * (p.y + v.y * t) >= halfHeight,
    );
  return first;
}
/** Conservative swept AABB in relative coordinates; never a replacement for the narrow phase. */
function possiblyTouches(start: Vec3, velocity: Vec3, radius: Vec3, duration: number) {
  let enter = 0,
    exit = duration;
  for (const axis of ['x', 'y', 'z'] as const) {
    const size = radius[axis] + 1e-3; // conservative outward allowance for f32 at the supported kilometre bounds
    if (Math.abs(velocity[axis]) < 1e-12) {
      if (Math.abs(start[axis]) > size) return false;
    } else {
      const a = (-size - start[axis]) / velocity[axis],
        b = (size - start[axis]) / velocity[axis];
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) return false;
    }
  }
  return true;
}
export function firstContact(
  a: Trace,
  shapeA: RAPIER.Shape,
  b: Trace,
  shapeB: RAPIER.Shape,
  skin = 0,
  includeInitialContact = false,
): number | undefined {
  const ea = extent(shapeA),
    eb = extent(shapeB);
  const ca = capsuleDimensions(shapeA),
    cb = capsuleDimensions(shapeB);
  const radius = ea && eb ? add(add(ea, eb), { x: skin, y: skin, z: skin }) : undefined;
  const boundaries =
    a.length === 1 && b.length === 1
      ? [0, 1]
      : [
          ...new Set([
            0,
            1,
            ...a.flatMap((s) => [s.from, s.to]),
            ...b.flatMap((s) => [s.from, s.to]),
          ]),
        ].sort((x, y) => x - y);
  for (let index = 0; index + 1 < boundaries.length; index++) {
    const from = boundaries[index]!;
    const to = boundaries[index + 1]!;
    if (to <= from) continue;
    const aStart = at(a, from),
      bStart = at(b, from);
    const va = mul(sub(at(a, to), aStart), 1 / (to - from));
    const vb = mul(sub(at(b, to), bStart), 1 / (to - from));
    const offset = sub(aStart, bStart),
      relative = sub(va, vb);
    if (radius && !possiblyTouches(offset, relative, radius, to - from)) continue;
    if (ca && cb) {
      const hit = capsuleTime(
        offset,
        relative,
        ca.radius + cb.radius + skin,
        ca.halfHeight + cb.halfHeight,
        to - from,
        includeInitialContact,
      );
      if (hit !== undefined) return from + hit;
      continue;
    }
    // Touching shapes that move apart must not stick together.
    const contact =
      (!radius || possiblyTouches(offset, ZERO, radius, 0)) &&
      shapeA.contactShape(aStart, IDENTITY, shapeB, bStart, IDENTITY, skin + CONTACT_TOLERANCE);
    if (includeInitialContact && contact && contact.distance <= skin + CONTACT_TOLERANCE)
      return from;
    if (
      contact &&
      contact.distance <= skin + CONTACT_TOLERANCE &&
      dot(sub(va, vb), contact.normal1) <= 0
    )
      continue;
    const hit = shapeA.castShape(
      aStart,
      IDENTITY,
      va,
      shapeB,
      bStart,
      IDENTITY,
      vb,
      skin,
      to - from,
      false,
    );
    if (hit) return from + hit.time_of_impact;
  }
  return undefined;
}
export const capsuleShape = (body: Capsule) => new RAPIER.Capsule(body.halfHeight, body.radius);
export type PhysicsShape = RAPIER.Shape;
export function obstacleShape(obstacle: Obstacle): PhysicsShape {
  const h = obstacle.halfExtents;
  return obstacle.kind === 'sphere'
    ? new RAPIER.Ball(h.x)
    : obstacle.kind === 'pillar'
      ? new RAPIER.Cylinder(h.y, h.x)
      : new RAPIER.Cuboid(h.x, h.y, h.z);
}
export const ballShape = (radius: number) => new RAPIER.Ball(radius);

export class SpatialWorld {
  readonly world: RAPIER.World;
  private readonly materials: Map<number, Obstacle>;
  private readonly bounds: Map<Layer, { center: Vec3; radius: Vec3 }>;
  private readonly meter: { casts: number; limit: number };
  private readonly query: SpatialQuery;
  private readonly ownsWorld: boolean;
  private readonly geometryKey: string;
  get casts() {
    return this.meter.casts;
  }
  set casts(value: number) {
    this.meter.casts = value;
  }
  get castLimit() {
    return this.meter.limit;
  }
  set castLimit(value: number) {
    this.meter.limit = value;
  }
  /** Stable authored obstacle order; adapters share the world's layer and work budget. */
  obstacles(layer: Layer): readonly Obstacle[] {
    return [...this.materials.values()].filter((obstacle) =>
      blocksQuery(obstacle, layer, this.query),
    );
  }
  allObstacles(): readonly Obstacle[] {
    return [...this.materials.values()];
  }
  queryBlocks(obstacle: Obstacle, layer: Layer): boolean {
    return blocksQuery(obstacle, layer, this.query);
  }
  countCast() {
    if (++this.casts > this.castLimit) throw new SpatialBudgetError('casts');
  }
  constructor(
    obstacles: Obstacle[],
    castLimit = 1_000_000,
    shared?: { source: SpatialWorld; query?: SpatialQuery; rebuild?: boolean },
  ) {
    this.meter = shared?.source.meter ?? { casts: 0, limit: castLimit };
    this.query = shared?.query ?? {};
    this.ownsWorld = !shared || !!shared.rebuild;
    this.geometryKey =
      shared && !shared.rebuild
        ? shared.source.geometryKey
        : canonicalJson(
            [...obstacles].sort(
              (a, b) =>
                (a.order ?? -1) - (b.order ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            ),
          );
    if (shared && !shared.rebuild) {
      this.world = shared.source.world;
      this.materials = shared.source.materials;
      this.bounds = shared.source.bounds;
      return;
    }
    this.materials = new Map();
    this.bounds = new Map();
    this.world = new RAPIER.World(ZERO);
    this.world.timestep = 0.02;
    try {
      for (const obstacle of [...obstacles].sort(
        (a, b) => (a.order ?? -1) - (b.order ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )) {
        if (shared) this.countCast();
        const desc = (
          obstacle.kind === 'sphere'
            ? RAPIER.ColliderDesc.ball(obstacle.halfExtents.x)
            : obstacle.kind === 'pillar'
              ? RAPIER.ColliderDesc.cylinder(obstacle.halfExtents.y, obstacle.halfExtents.x)
              : RAPIER.ColliderDesc.cuboid(
                  obstacle.halfExtents.x,
                  obstacle.halfExtents.y,
                  obstacle.halfExtents.z,
                )
        ).setTranslation(obstacle.position.x, obstacle.position.y, obstacle.position.z);
        if (obstacle.rotation) desc.setRotation(obstacle.rotation);
        const collider = this.world.createCollider(desc);
        this.materials.set(collider.handle, obstacle);
      }
      this.world.step(); // Populate the query acceleration structure once for static terrain.
      for (const layer of ['movement', 'vision', 'attack'] as const) {
        const relevant = obstacles.filter((o) => o.blocks[layer]);
        if (!relevant.length) continue;
        const lower = { x: Infinity, y: Infinity, z: Infinity },
          upper = { x: -Infinity, y: -Infinity, z: -Infinity };
        for (const obstacle of relevant) {
          const radius = obstacle.rotation
            ? {
                x: length(obstacle.halfExtents),
                y: length(obstacle.halfExtents),
                z: length(obstacle.halfExtents),
              }
            : obstacle.halfExtents;
          for (const axis of ['x', 'y', 'z'] as const) {
            lower[axis] = Math.min(lower[axis], obstacle.position[axis] - radius[axis]);
            upper[axis] = Math.max(upper[axis], obstacle.position[axis] + radius[axis]);
          }
        }
        this.bounds.set(layer, {
          center: mul(add(lower, upper), 0.5),
          radius: mul(sub(upper, lower), 0.5),
        });
      }
    } catch (error) {
      this.world.free();
      throw error;
    }
  }
  /** Immutable query views share geometry and the attempted-work meter, never filter state. */
  forQuery(query: SpatialQuery): SpatialWorld {
    return new SpatialWorld([], this.castLimit, {
      source: this,
      query: { ...this.query, ...query },
    });
  }
  /** A caller owns the candidate until its entire transaction commits. */
  rebuild(obstacles: Obstacle[]): SpatialWorld {
    if (
      canonicalJson(
        [...obstacles].sort(
          (a, b) => (a.order ?? -1) - (b.order ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        ),
      ) === this.geometryKey
    )
      return this;
    return new SpatialWorld(obstacles, this.castLimit, { source: this, rebuild: true });
  }
  free() {
    if (this.ownsWorld) this.world.free();
  }
  private count() {
    this.countCast();
  }
  sweep(start: Vec3, velocity: Vec3, shape: RAPIER.Shape, layer: Layer, maxTime = 1, skin = 0) {
    this.count();
    const bounds = this.bounds.get(layer),
      shapeExtent = extent(shape);
    if (!bounds) return null;
    if (
      shapeExtent &&
      !possiblyTouches(
        sub(start, bounds.center),
        velocity,
        add(add(bounds.radius, shapeExtent), { x: skin, y: skin, z: skin }),
        maxTime,
      )
    )
      return null;
    const ignored = new Set<number>();
    let best: SweepHit | null = null;
    const body = capsuleDimensions(shape);
    if (layer === 'movement' && body && shapeExtent) {
      for (const obstacle of this.materials.values()) {
        if (!blocksQuery(obstacle, layer, this.query) || obstacle.kind !== undefined) continue;
        const radius = obstacle.rotation ? length(obstacle.halfExtents) : 0;
        const half = radius ? { x: radius, y: radius, z: radius } : obstacle.halfExtents;
        if (
          !possiblyTouches(
            sub(start, obstacle.position),
            velocity,
            add(add(half, shapeExtent), { x: skin, y: skin, z: skin }),
            maxTime,
          )
        )
          continue;
        for (const axis of ['x', 'y', 'z'] as const)
          for (const sign of [-1, 1]) {
            const local = { x: 0, y: 0, z: 0, [axis]: sign };
            const normal = obstacle.rotation ? rotate(local, obstacle.rotation) : local;
            const time = planarContactTime(obstacle, normal, start, velocity, body, skin);
            if (time !== undefined && time <= maxTime && (!best || time < best.time_of_impact))
              best = { time_of_impact: time, normal1: normal, obstacleId: obstacle.id };
          }
      }
    }
    for (let pass = 0; pass <= this.materials.size; pass++) {
      if (pass > 0) this.count();
      const hit = this.world.castShape(
        start,
        IDENTITY,
        velocity,
        shape,
        skin,
        best ? Math.min(maxTime, best.time_of_impact) : maxTime,
        layer === 'attack',
        undefined,
        undefined,
        undefined,
        undefined,
        (collider) =>
          !ignored.has(collider.handle) &&
          blocksQuery(this.materials.get(collider.handle)!, layer, this.query),
      );
      if (!hit) return best;
      const obstacle = this.materials.get(hit.collider.handle)!;
      hit.normal1 = faceNormal(obstacle, hit.witness1, hit.normal1);
      if (layer === 'movement' && body) {
        const contact = capsuleObstacleContact(
          add(start, mul(velocity, hit.time_of_impact)),
          body,
          obstacle,
        );
        if (contact.normal) hit.normal1 = contact.normal;
      }
      if (layer !== 'movement')
        return {
          time_of_impact: hit.time_of_impact,
          normal1: hit.normal1,
          obstacleId: obstacle.id,
        };
      if (dot(velocity, hit.normal1) < -1e-10 || length(velocity) < 1e-12) {
        const refined =
          body && planarContactTime(obstacle, hit.normal1, start, velocity, body, skin);
        if (refined !== undefined) hit.time_of_impact = refined;
        if (hit.time_of_impact <= maxTime && (!best || hit.time_of_impact < best.time_of_impact))
          best = {
            time_of_impact: hit.time_of_impact,
            normal1: hit.normal1,
            obstacleId: obstacle.id,
          };
      }
      // A tangent/separating convex collider cannot block this straight segment. Search beyond it.
      ignored.add(hit.collider.handle);
    }
    return best;
  }

  raycast(start: Vec3, end: Vec3, layer: Layer) {
    this.count();
    const hit = this.world.castRayAndGetNormal(
      new RAPIER.Ray(start, sub(end, start)),
      1,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      (collider) => blocksQuery(this.materials.get(collider.handle)!, layer, this.query),
    );
    return hit
      ? {
          time: hit.timeOfImpact,
          point: lerp(start, end, hit.timeOfImpact),
          normal: hit.normal,
          obstacleId: this.materials.get(hit.collider.handle)!.id,
        }
      : undefined;
  }
  occluded(start: Vec3, end: Vec3, layer: Layer): boolean {
    return this.raycast(start, end, layer) !== undefined;
  }
  overlaps(position: Vec3, shape: RAPIER.Shape, layer: Layer = 'movement'): boolean {
    this.count();
    const body = capsuleDimensions(shape);
    if (body)
      return [...this.materials.values()].some(
        (obstacle) =>
          blocksQuery(obstacle, layer, this.query) &&
          (layer === 'attack'
            ? capsuleObstacleContact(position, body, obstacle).distance <= CONTACT_TOLERANCE
            : capsuleOverlapsObstacle(position, body, obstacle)),
      );
    let blocked = false;
    this.world.intersectionsWithShape(position, IDENTITY, shape, (collider) => {
      if (blocksQuery(this.materials.get(collider.handle)!, layer, this.query)) {
        const contact = shape.contactShape(
          position,
          IDENTITY,
          collider.shape,
          collider.translation(),
          collider.rotation(),
          0,
        );
        if (
          contact &&
          contact.distance <= (layer === 'attack' ? CONTACT_TOLERANCE : -CONTACT_TOLERANCE)
        )
          blocked = true;
      }
      return !blocked;
    });
    return blocked;
  }
  /** Move-and-slide with retained contact times and segments, unlike an endpoint-only controller. */
  trace(
    start: Vec3,
    requested: Vec3,
    body: Capsule,
    maxSegments = 8,
    minGroundY = 0,
    projections?: MotionProjection[],
  ): Trace {
    const shape = capsuleShape(body);
    const trace: Trace = [];
    let position = start,
      velocity = requested,
      time = 0;
    for (let segment = 0; segment < maxSegments; segment++) {
      if (time >= 1) return trace;
      if (length(velocity) < 1e-10) {
        trace.push({ start: position, end: position, from: time, to: 1 });
        return trace;
      }
      const hit = this.sweep(position, velocity, shape, 'movement', 1 - time, COLLISION_SKIN);
      const duration = hit ? Math.max(0, Math.min(1 - time, hit.time_of_impact)) : 1 - time;
      const end = add(position, mul(velocity, duration));
      if (duration > 0) trace.push({ start: position, end, from: time, to: time + duration });
      position = end;
      time += duration;
      if (!hit || (time >= 1 && !projections)) return trace;
      // World shape-cast normals are transformed by Rapier to world coordinates.
      let normal = hit.normal1;
      const into = dot(velocity, normal);
      let slid = sub(velocity, mul(normal, Math.min(0, into)));
      if (normal.y > 0 && normal.y < minGroundY && slid.y > Math.max(0, velocity.y)) {
        const wallNormal = unit({ x: normal.x, y: 0, z: normal.z });
        slid = sub(velocity, mul(wallNormal, Math.min(0, dot(velocity, wallNormal))));
        normal = wallNormal;
      }
      if (dot(velocity, normal) < 0)
        projections?.push({
          fraction: time,
          kind: 'wall',
          normal: { ...normal },
          obstacleId: hit.obstacleId,
        });
      if (time >= 1) return trace;
      if (length(sub(slid, velocity)) < 1e-10) {
        projections?.push({
          fraction: time,
          kind: 'stop',
          normal: null,
          obstacleId: hit.obstacleId,
        });
        trace.push({ start: position, end: position, from: time, to: 1 });
        return trace;
      }
      velocity = slid;
    }
    throw new SpatialBudgetError('movement-segments');
  }
}
