import { hashJson, SeedSchema } from '@fantasy/domain/tick-v1';

// Marsaglia, Xorshift RNGs (2003), xorshift32 with shifts (13, 17, 5).
export function nextRandomState(state: number): number {
  let next = state ^ (state << 13);
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

/** Nonzero uint32 state. Rejection removes modulo bias from the 2^32 - 1 period. */
export function sampleBps(input: number): { state: number; value: number } {
  let state = SeedSchema.parse(input);
  for (let attempt = 0; attempt < 7_296; attempt++) {
    state = nextRandomState(state);
    const zeroBased = state - 1;
    if (zeroBased < 4_294_960_000) return { state, value: zeroBased % 10_000 };
  }
  throw new Error('PRNG invariant failed');
}

export async function characterRandomState(seed: number, characterHash: string): Promise<number> {
  const hash = await hashJson(['character-sha256-v1', seed, characterHash]);
  return Number.parseInt(hash.slice('sha256:'.length, 'sha256:'.length + 8), 16) || 1;
}
