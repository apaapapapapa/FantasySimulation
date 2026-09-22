import { add, cross, dot, mul, sub, type Vec3 } from './math.ts';
import type { Capsule, Obstacle } from './physics.ts';

type Rotation = { x: number; y: number; z: number; w: number };
export function rotate(vector: Vec3, rotation: Rotation): Vec3 {
  const q = { x: rotation.x, y: rotation.y, z: rotation.z };
  const t = mul(cross(q, vector), 2);
  return add(vector, add(mul(t, rotation.w), cross(q, t)));
}
const inverse = (q: Rotation) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

/** Squared segment/box distance, minimizing the quadratic in every face-crossing interval. */
function segmentBoxDistanceSquared(start: Vec3, end: Vec3, half: Vec3): number {
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
  let best = Math.min(distance(0), distance(1));
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
    best = Math.min(best, distance(a === 0 ? middle : Math.max(low, Math.min(high, -b / a))));
  }
  return best;
}
export function capsuleOverlapsObstacle(
  position: Vec3,
  body: Capsule,
  obstacle: Obstacle,
): boolean {
  const local = sub(position, obstacle.position);
  let squared: number;
  if (obstacle.kind === 'pillar') {
    const horizontal = Math.max(0, Math.sqrt(local.x ** 2 + local.z ** 2) - obstacle.halfExtents.x);
    const vertical = Math.max(0, Math.abs(local.y) - body.halfHeight - obstacle.halfExtents.y);
    squared = horizontal ** 2 + vertical ** 2;
  } else {
    let start = add(local, { x: 0, y: -body.halfHeight, z: 0 }),
      end = add(local, { x: 0, y: body.halfHeight, z: 0 });
    if (obstacle.rotation) {
      const inv = inverse(obstacle.rotation);
      start = rotate(start, inv);
      end = rotate(end, inv);
    }
    squared = segmentBoxDistanceSquared(start, end, obstacle.halfExtents);
  }
  return squared < Math.max(0, body.radius - 1e-6) ** 2;
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
