import { sinDegrees, cosDegrees } from '@fantasy/domain/spatial/execution';
export { sinDegrees, cosDegrees } from '@fantasy/domain/spatial/execution';

export type Vec3 = { x: number; y: number; z: number };
export const ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });
export const IDENTITY = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const mul = (a: Vec3, n: number): Vec3 => ({ x: a.x * n, y: a.y * n, z: a.z * n });
export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const length = (a: Vec3) => Math.sqrt(dot(a, a));
export const unit = (a: Vec3): Vec3 => (length(a) > 1e-12 ? mul(a, 1 / length(a)) : { ...ZERO });
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const lerp = (a: Vec3, b: Vec3, t: number) => add(a, mul(sub(b, a), t));

export function turnToward(facing: Vec3, desired: Vec3, degrees: number): Vec3 {
  const from = unit(facing);
  const to = unit(desired);
  if (length(to) < 1e-12) return from;
  if (degrees >= 180 || dot(from, to) >= cosDegrees(degrees)) return to;
  let tangent = unit(sub(to, mul(from, dot(from, to))));
  if (length(tangent) < 1e-12) {
    // The reference depends only on absolute components, so inversion negates the cross product.
    const reference = Math.abs(from.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    tangent = unit(cross(reference, from));
  }
  return unit(add(mul(from, cosDegrees(degrees)), mul(tangent, sinDegrees(degrees))));
}

export { floatBits, encodeNumericState } from '@fantasy/domain/spatial/execution';
