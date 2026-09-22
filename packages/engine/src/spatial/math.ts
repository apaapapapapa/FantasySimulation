import sine from './sine-table.json' with { type: 'json' };

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

/** Versioned 1-degree table, linear interpolation. No runtime transcendental functions. */
export function sinDegrees(degrees: number): number {
  const angle = ((degrees % 360) + 360) % 360;
  const sign = angle > 180 ? -1 : 1;
  const half = angle > 180 ? angle - 180 : angle;
  const quarter = half > 90 ? 180 - half : half;
  const lower = Math.floor(quarter);
  const a = sine[lower]!;
  const b = sine[Math.min(90, lower + 1)]!;
  return (sign * (a + (b - a) * (quarter - lower))) / 1_000_000_000;
}
export const cosDegrees = (degrees: number) => sinDegrees(90 + degrees);

export function turnToward(facing: Vec3, desired: Vec3, degrees: number): Vec3 {
  const from = unit(facing);
  const to = unit(desired);
  if (length(to) < 1e-12) return from;
  if (degrees >= 180 || dot(from, to) >= cosDegrees(degrees)) return to;
  let tangent = unit(sub(to, mul(from, dot(from, to))));
  if (length(tangent) < 1e-12) {
    tangent = unit(cross({ x: 0, y: 1, z: 0 }, from));
    if (length(tangent) < 1e-12) tangent = { x: 1, y: 0, z: 0 };
  }
  return unit(add(mul(from, cosDegrees(degrees)), mul(tangent, sinDegrees(degrees))));
}

/** Exact binary64 big-endian encoding; canonicalize -0, reject non-finite state. */
export function floatBits(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Non-finite physical state');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, Object.is(value, -0) ? 0 : value, false);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function encodeNumericState(input: unknown): unknown {
  if (typeof input === 'number') return { f64: floatBits(input) };
  if (Array.isArray(input)) return input.map(encodeNumericState);
  if (input !== null && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => [key, encodeNumericState(value)]),
    );
  }
  return input;
}
