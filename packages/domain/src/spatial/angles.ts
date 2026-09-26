import sine from './sine-table.json' with { type: 'json' };
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
