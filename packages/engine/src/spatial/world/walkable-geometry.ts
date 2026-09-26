import type { Obstacle } from '../geometry-types.ts';
import { add, sub, mul, dot, length, unit, type Vec3 } from '../math.ts';
import { bladeObstacleContact, rotate } from './geometry.ts';

const clamp = (t: number) => Math.max(0, Math.min(1, t));
/** Closest supporting surface, including edges, to a horizontal blade or upright body axis.
 * Ignored side faces must not hide a later supporting contact on the same collider. */
export function walkableContact(
  start: Vec3,
  end: Vec3,
  radius: number,
  obstacle: Obstacle,
  slope: number,
) {
  if (obstacle.kind === undefined) {
    const contacts = [];
    for (const axis of ['x', 'y', 'z'] as const)
      for (const sign of [-1, 1]) {
        const local = { x: 0, y: 0, z: 0, [axis]: sign },
          normal = obstacle.rotation ? rotate(local, obstacle.rotation) : local;
        if (normal.y < slope) continue;
        const face = {
          ...obstacle,
          position: add(obstacle.position, mul(normal, obstacle.halfExtents[axis])),
          halfExtents: { ...obstacle.halfExtents, [axis]: 0 },
        };
        contacts.push({ ...bladeObstacleContact(start, end, radius, face), normal });
      }
    return contacts.sort((a, b) => a.distance - b.distance)[0];
  }
  const a = sub(start, obstacle.position),
    v = sub(end, start),
    horizontal = v.x * v.x + v.z * v.z,
    nearest = horizontal ? clamp(-(a.x * v.x + a.z * v.z) / horizontal) : 0,
    times = new Set([0, 1, nearest]),
    R = obstacle.halfExtents.x;
  const roots = (square: number, projection: number, constant: number) => {
    const discriminant = projection * projection - square * constant;
    if (square <= 1e-24 || discriminant < 0) return;
    for (const sign of [-1, 1]) {
      const t = (-projection + sign * Math.sqrt(discriminant)) / square;
      if (t >= 0 && t <= 1) times.add(t);
    }
  };
  const capY = obstacle.kind === 'pillar' ? obstacle.halfExtents.y : R * slope,
    ring = obstacle.kind === 'pillar' ? R : R * Math.sqrt(Math.max(0, 1 - slope * slope));
  if (horizontal < 1e-24 && Math.abs(v.y) > 1e-12) times.add(clamp((capY - a.y) / v.y));
  roots(horizontal, a.x * v.x + a.z * v.z, a.x * a.x + a.z * a.z - ring * ring);
  if (obstacle.kind === 'sphere') {
    if (dot(v, v)) times.add(clamp(-dot(a, v) / dot(v, v)));
    roots(dot(v, v), dot(a, v), dot(a, a) - R * R);
  }
  const contacts = [...times].map((t) => {
    const p = add(a, mul(v, t)),
      radial = Math.sqrt(p.x * p.x + p.z * p.z),
      n = unit(p);
    const q =
      obstacle.kind === 'sphere' && n.y >= slope
        ? mul(n, R)
        : {
            x: radial
              ? (p.x * (obstacle.kind === 'pillar' ? Math.min(radial, ring) : ring)) / radial
              : ring,
            y: capY,
            z: radial
              ? (p.z * (obstacle.kind === 'pillar' ? Math.min(radial, ring) : ring)) / radial
              : 0,
          };
    // The axis may pass through the disk center; it is not projected to the rim.
    if (obstacle.kind === 'pillar' && !radial) q.x = 0;
    return {
      distance: length(sub(p, q)) - radius,
      point: add(obstacle.position, q),
      normal: obstacle.kind === 'sphere' ? unit(q) : { x: 0, y: 1, z: 0 },
    };
  });
  return contacts.sort((a, b) => a.distance - b.distance)[0];
}
