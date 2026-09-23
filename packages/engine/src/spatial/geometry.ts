import { add, cross, dot, mul, sub, unit, type Vec3 } from './math.ts';
import type { Capsule, Obstacle } from './physics.ts';

type Rotation = { x: number; y: number; z: number; w: number };
export function rotate(vector: Vec3, rotation: Rotation): Vec3 {
  const q = { x: rotation.x, y: rotation.y, z: rotation.z };
  const t = mul(cross(q, vector), 2);
  return add(vector, add(mul(t, rotation.w), cross(q, t)));
}
const inverse = (q: Rotation) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

/** Squared segment/box distance, minimizing the quadratic in every face-crossing interval. */
function segmentBoxClosest(start: Vec3, end: Vec3, half: Vec3) {
  const velocity = sub(end, start),
    breaks = [0, 1];
  for (const axis of ['x', 'y', 'z'] as const)
    if (velocity[axis] !== 0)
      for (const sign of [-1, 1]) {
        const t = (sign * half[axis] - start[axis]) / velocity[axis];
        if (t > 0 && t < 1) breaks.push(t);
      }
  breaks.sort((a, b) => a - b);
  const distance = (t: number) => {
    const point = add(start, mul(velocity, t));
    return (
      Math.max(0, Math.abs(point.x) - half.x) ** 2 +
      Math.max(0, Math.abs(point.y) - half.y) ** 2 +
      Math.max(0, Math.abs(point.z) - half.z) ** 2
    );
  };
  let bestTime = distance(0) <= distance(1) ? 0 : 1;
  let best = distance(bestTime);
  for (let i = 0; i < breaks.length - 1; i++) {
    const low = breaks[i]!,
      high = breaks[i + 1]!,
      middle = (low + high) / 2;
    let a = 0,
      b = 0;
    for (const axis of ['x', 'y', 'z'] as const) {
      const p = start[axis] + velocity[axis] * middle;
      if (Math.abs(p) <= half[axis]) continue;
      const offset = start[axis] - (p < 0 ? -half[axis] : half[axis]);
      a += velocity[axis] ** 2;
      b += offset * velocity[axis];
    }
    const time = a === 0 ? middle : Math.max(low, Math.min(high, -b / a));
    if (distance(time) < best) {
      bestTime = time;
      best = distance(time);
    }
  }
  const point = add(start, mul(velocity, bestTime));
  const delta = {
    x: point.x - Math.max(-half.x, Math.min(half.x, point.x)),
    y: point.y - Math.max(-half.y, Math.min(half.y, point.y)),
    z: point.z - Math.max(-half.z, Math.min(half.z, point.z)),
  };
  return { squared: best, delta, point };
}
/** Whole horizontal blade, including its shaft, against boxes/ramps and upright pillars. */
export function bladeObstacleContact(start: Vec3, end: Vec3, radius: number, obstacle: Obstacle) {
  if (obstacle.kind === 'pillar') {
    const axis = closestHorizontal(start, end, obstacle.position);
    const delta = sub(axis, obstacle.position);
    const radial = Math.sqrt(delta.x ** 2 + delta.z ** 2);
    const horizontal = Math.max(0, radial - obstacle.halfExtents.x);
    const vertical = Math.max(0, Math.abs(delta.y) - obstacle.halfExtents.y);
    const gap = {
      x: radial ? (delta.x * horizontal) / radial : 0,
      y: Math.sign(delta.y) * vertical,
      z: radial ? (delta.z * horizontal) / radial : 0,
    };
    return {
      distance: Math.sqrt(horizontal ** 2 + vertical ** 2) - radius,
      point: sub(axis, mul(unit(gap), radius)),
    };
  }
  const local = (p: Vec3) =>
    obstacle.rotation
      ? rotate(sub(p, obstacle.position), inverse(obstacle.rotation))
      : sub(p, obstacle.position);
  const closest = segmentBoxClosest(local(start), local(end), obstacle.halfExtents);
  const axis = add(
    obstacle.position,
    obstacle.rotation ? rotate(closest.point, obstacle.rotation) : closest.point,
  );
  const gap = obstacle.rotation ? rotate(closest.delta, obstacle.rotation) : closest.delta;
  return {
    distance: Math.sqrt(closest.squared) - radius,
    point: sub(axis, mul(unit(gap), radius)),
  };
}
function closestHorizontal(start: Vec3, end: Vec3, position: Vec3) {
  const delta = { ...sub(end, start), y: 0 },
    square = dot(delta, delta);
  const time =
    square === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(position, start), delta) / square));
  return add(start, mul(delta, time));
}
export function bladeBodyContact(
  start: Vec3,
  end: Vec3,
  radius: number,
  position: Vec3,
  body: Capsule,
) {
  const axis = closestHorizontal(start, end, position);
  const nearest = {
    ...position,
    y: Math.max(position.y - body.halfHeight, Math.min(position.y + body.halfHeight, axis.y)),
  };
  const delta = sub(axis, nearest);
  return {
    distance: Math.sqrt(dot(delta, delta)) - radius - body.radius,
    point: sub(axis, mul(unit(delta), radius)),
  };
}
export function capsuleObstacleContact(position: Vec3, body: Capsule, obstacle: Obstacle) {
  const local = sub(position, obstacle.position);
  let squared: number, delta: Vec3;
  if (obstacle.kind === 'pillar') {
    const radius = Math.sqrt(local.x ** 2 + local.z ** 2);
    const horizontal = Math.max(0, radius - obstacle.halfExtents.x);
    const vertical = Math.max(0, Math.abs(local.y) - body.halfHeight - obstacle.halfExtents.y);
    squared = horizontal ** 2 + vertical ** 2;
    delta = {
      x: radius ? (local.x * horizontal) / radius : 0,
      y: Math.sign(local.y) * vertical,
      z: radius ? (local.z * horizontal) / radius : 0,
    };
  } else {
    let start = add(local, { x: 0, y: -body.halfHeight, z: 0 }),
      end = add(local, { x: 0, y: body.halfHeight, z: 0 });
    if (obstacle.rotation) {
      const inv = inverse(obstacle.rotation);
      start = rotate(start, inv);
      end = rotate(end, inv);
    }
    const closest = segmentBoxClosest(start, end, obstacle.halfExtents);
    squared = closest.squared;
    delta = obstacle.rotation ? rotate(closest.delta, obstacle.rotation) : closest.delta;
  }
  return {
    distance: Math.sqrt(squared) - body.radius,
    normal: squared > 1e-24 ? unit(delta) : undefined,
  };
}
export function capsuleOverlapsObstacle(
  position: Vec3,
  body: Capsule,
  obstacle: Obstacle,
): boolean {
  return capsuleObstacleContact(position, body, obstacle).distance < -1e-6;
}

/** Stabilize a contact strictly inside a box face; preserve edge/corner normals. */
export function faceNormal(obstacle: Obstacle, point: Vec3, fallback: Vec3): Vec3 {
  if (obstacle.kind === 'pillar') return fallback;
  const local = obstacle.rotation
    ? rotate(sub(point, obstacle.position), inverse(obstacle.rotation))
    : sub(point, obstacle.position);
  const axes = (['x', 'y', 'z'] as const).filter(
    (axis) => Math.abs(Math.abs(local[axis]) - obstacle.halfExtents[axis]) < 0.005,
  );
  if (axes.length !== 1) return fallback;
  const axis = axes[0]!;
  const normal = { x: 0, y: 0, z: 0 };
  normal[axis] = local[axis] < 0 ? -1 : 1;
  const result = obstacle.rotation ? rotate(normal, obstacle.rotation) : normal;
  return dot(result, fallback) > 0.9 ? result : fallback;
}

/** Refine GJK's f32 time only when the capsule support point lies inside a planar box face. */
export function planarContactTime(
  obstacle: Obstacle,
  normal: Vec3,
  start: Vec3,
  velocity: Vec3,
  body: Capsule,
  skin: number,
): number | undefined {
  if (obstacle.kind === 'pillar' || dot(normal, velocity) >= -1e-12) return undefined;
  const localNormal = obstacle.rotation ? rotate(normal, inverse(obstacle.rotation)) : normal;
  const axis = (['x', 'y', 'z'] as const).find((a) => Math.abs(localNormal[a]) > 1 - 1e-10);
  if (!axis) return undefined;
  const localFace = { x: 0, y: 0, z: 0 };
  localFace[axis] = Math.sign(localNormal[axis]) * obstacle.halfExtents[axis];
  const face = add(
    obstacle.position,
    obstacle.rotation ? rotate(localFace, obstacle.rotation) : localFace,
  );
  const extent = body.radius + body.halfHeight * Math.abs(normal.y);
  const separation = dot(sub(start, face), normal) - extent;
  if (separation < -1e-6) return undefined; // Opposite/back faces are not entering contacts.
  const time = Math.max(0, (skin - separation) / dot(velocity, normal));
  const support = sub(
    add(start, mul(velocity, time)),
    add(mul(normal, body.radius + skin), { x: 0, y: Math.sign(normal.y) * body.halfHeight, z: 0 }),
  );
  const local = obstacle.rotation
    ? rotate(sub(support, obstacle.position), inverse(obstacle.rotation))
    : sub(support, obstacle.position);
  return (['x', 'y', 'z'] as const).every(
    (a) => a === axis || Math.abs(local[a]) < obstacle.halfExtents[a] - 1e-6,
  )
    ? time
    : undefined;
}
