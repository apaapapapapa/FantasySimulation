import type { LeagueScore } from '@fantasy/domain/spatial';

type LeagueFraction = LeagueScore['lower'];

/** Round only for display, after arbitrary-precision division; never sort rounded scores. */
export function leagueDecimal(value: LeagueFraction, multiplier = 1) {
  const denominator = BigInt(value.denominator);
  const hundredths =
    (BigInt(value.numerator) * BigInt(multiplier) * 200n + denominator) / (denominator * 2n);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}
export const leaguePercent = (value: LeagueFraction) => `${leagueDecimal(value, 100)}%`;
export function leagueInterval(score: LeagueScore) {
  return BigInt(score.lower.numerator) * BigInt(score.upper.denominator) ===
    BigInt(score.upper.numerator) * BigInt(score.lower.denominator)
    ? `${leagueDecimal(score.lower)}点`
    : `${leagueDecimal(score.lower)}〜${leagueDecimal(score.upper)}点`;
}
export function compareLeagueScore(a: LeagueFraction, b: LeagueFraction) {
  const difference =
    BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
