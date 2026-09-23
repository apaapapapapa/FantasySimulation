import { describe, expect, it } from 'vite-plus/test';
import { nextRandom } from '@fantasy/domain/spatial';
import { initialDecisionRandom, weightedChoice } from './decision-random.ts';
import { launchDirection } from './attacks.ts';

describe('purpose-separated unbiased decision draws', () => {
  it('retains state for no candidate or a sole positive candidate and rejects invalid weights', () => {
    expect(weightedChoice([0, 0], 19)).toEqual({ index: null, state: 19, draws: 0, total: 0 });
    expect(weightedChoice([0, 17, 0], 19)).toEqual({ index: 1, state: 19, draws: 0, total: 17 });
    for (const weights of [[-0.1], [1.1], [1_000_001], Array(36).fill(1)])
      expect(() => weightedChoice(weights, 19)).toThrow(/Invalid decision weights/);
  });
  it('maps equal weights without modulo bias and handles each weighted boundary', () => {
    // Reverse xorshift32 in GF(2), using independently specified inverse shifts.
    const inverse = (value: number) => {
      for (const [shift, left] of [
        [5, true],
        [17, false],
        [13, true],
      ] as const) {
        let x = value;
        for (let i = 0; i < 32; i++) x = (value ^ (left ? x << shift : x >>> shift)) >>> 0;
        value = x;
      }
      return value;
    };
    for (const [value, index] of [
      [0, 0],
      [1, 0],
      [2, 1],
      [4, 1],
      [5, 2],
      [9, 2],
    ] as const) {
      const state = inverse(value + 1);
      expect(nextRandom(state)).toBe(value + 1);
      expect(weightedChoice([2, 3, 5], state).index).toBe(index);
    }
    for (let index = 0; index < 4; index++)
      expect(weightedChoice([7, 7, 7, 7], inverse(index * 7 + 1)).index).toBe(index);
    expect(weightedChoice([1, 1, 1, 1], inverse(0xffffffff)).draws).toBeGreaterThan(1);
  });
  it('repeats a fixed seed set, reaches all directions, and never advances the aim stream', () => {
    const picks = new Set<number>();
    for (let seed = 1; seed <= 128; seed++) {
      const random = initialDecisionRandom(seed),
        before = launchDirection({ x: 1, y: 0, z: 0 }, 300, seed);
      const choice = weightedChoice([1, 1, 1, 1], random.dodge);
      picks.add(choice.index!);
      expect(weightedChoice([1, 1, 1, 1], random.dodge)).toEqual(choice);
      weightedChoice([3, 8], random.action);
      expect(launchDirection({ x: 1, y: 0, z: 0 }, 300, seed)).toEqual(before);
      expect(random.action).not.toBe(random.dodge);
    }
    expect([...picks].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});
