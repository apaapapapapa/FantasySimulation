import type { DecisionRandom } from '../state.ts';
export type { DecisionRandom } from '../state.ts';
import { nextRandom } from '@fantasy/domain/spatial/execution';
import { SpatialBudgetError } from '../world/physics.ts';

export const initialSearchRandom = (seed: number) => nextRandom((seed ^ 0xa4093822) >>> 0 || 1);
export const initialCoverRandom = (seed: number) => nextRandom((seed ^ 0x299f31d0) >>> 0 || 1);
export const initialMovementRandom = (actorSeed: number) =>
  nextRandom((actorSeed ^ 0x13198a2e) >>> 0 || 1);
export function initialDecisionRandom(actorSeed: number): DecisionRandom {
  return {
    action: nextRandom((actorSeed ^ 0x243f6a88) >>> 0 || 1),
    dodge: nextRandom((actorSeed ^ 0x85a308d3) >>> 0 || 1),
  };
}
/** Xorshift's nonzero state space has 2^32-1 elements. Reject its incomplete final bucket. */
export function weightedChoice(
  weights: readonly number[],
  state: number,
  minimumCandidateWeightBps = 0,
) {
  if (
    weights.length > 35 ||
    Array.from(weights).some((w) => !Number.isSafeInteger(w) || w < 0 || w > 1_000_000)
  )
    throw new Error('Invalid decision weights');
  if (
    !Number.isInteger(minimumCandidateWeightBps) ||
    minimumCandidateWeightBps < 0 ||
    minimumCandidateWeightBps > 10000
  )
    throw new Error('Invalid decision weight cutoff');
  // Compare exact integers against the best ORIGINAL weight, never the sum or a
  // rounded probability. The largest product is 1e10, below Number.MAX_SAFE_INTEGER.
  const best = Math.max(0, ...weights);
  const effective = weights.map((w) => (w * 10000 < best * minimumCandidateWeightBps ? 0 : w));
  const eligible = effective.map((w, i) => ({ w, i })).filter(({ w }) => w > 0),
    total = eligible.reduce((n, v) => n + v.w, 0);
  if (eligible.length < 2)
    return { index: eligible[0]?.i ?? null, state, draws: 0, total, weights: effective };
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
      if (roll < candidate.w)
        return { index: candidate.i, state, draws, total, weights: effective };
      roll -= candidate.w;
    }
  }
  throw new SpatialBudgetError('ai-random-rejection');
}

/** Keep pruned candidates observable without changing legacy decision records. */
export function recordDecisionWeights(
  candidates: { weight: number; weightBeforeCutoff?: number | undefined }[],
  choice: ReturnType<typeof weightedChoice>,
  minimumCandidateWeightBps: number | undefined,
) {
  if (minimumCandidateWeightBps === undefined) return;
  for (const [index, candidate] of candidates.entries()) {
    candidate.weightBeforeCutoff = candidate.weight;
    candidate.weight = choice.weights[index]!;
  }
}
