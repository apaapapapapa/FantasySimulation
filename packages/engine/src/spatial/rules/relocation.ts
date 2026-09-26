import type { DeepReadonly, Relocation } from '@fantasy/domain/spatial/execution';
import type { Capsule } from '../geometry-types.ts';
import { add, length, mul, sub, unit, type Vec3 } from '../math.ts';
import { CONTACT_TOLERANCE } from '../world/physics.ts';

export function relocationDestination(
  spec: DeepReadonly<Relocation>,
  self: { position: Vec3; facing: Vec3 },
  visible: { position: Vec3; facing: Vec3 } | null | undefined,
): Vec3 | null {
  const anchor = spec.anchor === 'self' ? self : visible;
  if (!anchor) return null;
  const forward = unit({ ...anchor.facing, y: 0 });
  if (length(forward) === 0) forward.x = 1;
  const right = { x: -forward.z, y: 0, z: forward.x };
  const axis = spec.direction === 'front' || spec.direction === 'back' ? forward : right;
  const sign = spec.direction === 'back' || spec.direction === 'left' ? -1 : 1;
  const p = add(anchor.position, mul(axis, (sign * spec.distanceMm) / 1000));
  const round = (n: number) => (Math.sign(n) * Math.floor(Math.abs(n) * 1000 + 0.5)) / 1000;
  return { x: round(p.x), y: round(p.y), z: round(p.z) };
}
export function capsulesOverlap(a: Vec3, ca: Capsule, b: Vec3, cb: Capsule): boolean {
  const delta = sub(a, b);
  const dy = Math.max(0, Math.abs(delta.y) - ca.halfHeight - cb.halfHeight);
  return delta.x ** 2 + delta.z ** 2 + dy ** 2 < (ca.radius + cb.radius - CONTACT_TOLERANCE) ** 2;
}
