import { afterEach, expect, it, vi } from 'vite-plus/test';
import {
  Measurements,
  distribution,
  measureAsync,
  measureSync,
  currentMeasurements,
} from './measurements.ts';

afterEach(() => vi.restoreAllMocks());
it('unions nested and concurrent intervals instead of adding work to wall time', () => {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const m = new Measurements();
  const a = m.start('save');
  clock = 10;
  const b = m.start('save');
  clock = 15;
  const c = m.start('hash');
  clock = 20;
  a();
  clock = 25;
  c(false);
  clock = 30;
  b();
  b();
  clock = 40;
  expect(m.report()).toMatchObject({
    wallMs: 40,
    measuredSpanUnionMs: 30,
    unseparatedMs: 10,
    incompleteSpans: 0,
    stages: {
      save: { count: 2, inclusiveMs: 40, busyWallMs: 30 },
      hash: { count: 1, failures: 1, inclusiveMs: 10 },
    },
  });
});
it('reports unfinished spans, missing samples and exact nearest-rank quantiles', () => {
  const m = new Measurements();
  m.start('interrupted');
  expect(m.report()).toMatchObject({
    incompleteSpans: 1,
    matchWallMs: { median: null, p95: null, max: null },
  });
  expect(distribution([4, 1, 20, 3])).toEqual({ count: 4, median: 3.5, p95: 20, max: 20 });
  expect(distribution(Array.from({ length: 20 }, (_, i) => i + 1)).p95).toBe(19);
});
it('preserves values and exact errors and isolates concurrent measurement contexts', async () => {
  const a = new Measurements(),
    b = new Measurements(),
    error = new Error('sentinel');
  await Promise.all([
    a.run(async () => {
      expect(measureSync('hash', () => 42)).toBe(42);
      await expect(
        measureAsync('read', async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      expect(() =>
        measureSync('syncFailure', () => {
          throw error;
        }),
      ).toThrow(error);
    }),
    b.run(async () => {
      await measureAsync('write', async () => 'ok');
    }),
  ]);
  expect(currentMeasurements()).toBeUndefined();
  expect(a.report().stages).not.toHaveProperty('write');
  expect(b.report().stages).not.toHaveProperty('hash');
  expect(a.report().stages.read).toMatchObject({ count: 1, failures: 1 });
});
it('counts every verification, including repeats and rejected replays, without retaining payloads', () => {
  const m = new Measurements();
  m.validation('replay-a', true);
  m.validation('replay-a', false);
  m.validation('replay-b', true);
  expect(m.report().validation).toMatchObject({
    calls: 3,
    uniqueReplays: 2,
    repeatedCalls: 1,
    replays: { 'replay-a': { calls: 2, failures: 1 } },
  });
});
