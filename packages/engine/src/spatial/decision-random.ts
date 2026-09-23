import { nextRandom } from '@fantasy/domain/spatial';
import { SpatialBudgetError } from './physics.ts';

export type DecisionRandom = { action: number; dodge: number };
export function initialDecisionRandom(actorSeed: number): DecisionRandom {
  return {
    action: nextRandom((actorSeed ^ 0x243f6a88) >>> 0 || 1),
    dodge: nextRandom((actorSeed ^ 0x85a308d3) >>> 0 || 1),
  };
}
/** Xorshift's nonzero state space has 2^32-1 elements. Reject its incomplete final bucket. */
export function weightedChoice(weights: readonly number[], state: number) {
  if (
    weights.length > 35 ||
    weights.some((w) => !Number.isSafeInteger(w) || w < 0 || w > 1_000_000)
  )
    throw new Error('Invalid decision weights');
  const eligible = weights.map((w, i) => ({ w, i })).filter(({ w }) => w > 0),
    total = eligible.reduce((n, v) => n + v.w, 0);
  if (eligible.length < 2) return { index: eligible[0]?.i ?? null, state, draws: 0, total };
  if (!Number.isInteger(state) || state <= 0 || state > 0xffffffff)
    throw new Error('Invalid decision random state');
  const space = 0xffffffff,
    limit = Math.floor(space / total) * total;
  for (let draws = 1; draws <= 128; draws++) {
    state = nextRandom(state);
    const value = state - 1;
    if (value >= limit) continue;
    let roll = value % total;
    for (const candidate of eligible) {
      if (roll < candidate.w) return { index: candidate.i, state, draws, total };
      roll -= candidate.w;
    }
  }
  throw new SpatialBudgetError('ai-random-rejection');
}
