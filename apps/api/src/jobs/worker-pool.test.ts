import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import { GCProfiler } from 'node:v8';
import { observeGc } from './gc-observation.ts';
import { availableParallelism } from 'node:os';
import { DEFAULT_BUDGET, type StreamRecord } from '@fantasy/domain/spatial';
import { runBattle } from '@fantasy/engine/spatial';
import { catalogManifest } from '@fantasy/samples';
import { Measurements } from '../measurements.ts';
import { BattlePool } from './worker-pool.ts';

describe('reused calculation Workers', () => {
  it('matches the engine pull stream and records backpressure, with no knowledge carried between matches', async () => {
    const manifest = await catalogManifest('archer', 'guardian', 'flat', 250);
    const direct = await runBattle(manifest),
      pool = new BattlePool(1);
    try {
      const records: unknown[] = [];
      const first = await new Measurements().run(() =>
        pool.run(
          manifest,
          DEFAULT_BUDGET,
          async (batch) => {
            records.push(...batch);
          },
          new AbortController().signal,
        ),
      );
      expect(first.observation?.gcCount).toBeGreaterThanOrEqual(0);
      expect(first.observation?.gcDurationMs).toBeGreaterThanOrEqual(0);
      expect(first.result).toEqual(direct.result);
      expect(records).toEqual(direct.records);
      const second = await pool.run(
        manifest,
        DEFAULT_BUDGET,
        async () => {},
        new AbortController().signal,
      );
      expect(second.observation).toBeUndefined();
      expect(second.result).toEqual(first.result);
      expect(second.metrics.threadId).toBe(first.metrics.threadId);
      expect(first.metrics.cold).toBe(true);
      expect(second.metrics.cold).toBe(false);
      expect(first.metrics.peakBatchBytes).toBeLessThanOrEqual(131072);
      expect(first.metrics.heapUsed).toBeLessThan(128 * 1024 ** 2);
      expect(first.metrics.wasmLinearBytes).toBeGreaterThan(0);
      expect(second.metrics.wasmLinearBytes).toBe(first.metrics.wasmLinearBytes);
    } finally {
      await pool.close();
    }
  });
  it('is independent of pool size/completion order and replaces an aborted Worker', async () => {
    const manifest = await catalogManifest('swordsman', 'sky-mage', 'flat', 25);
    const pool = new BattlePool(Math.min(4, Math.max(1, availableParallelism() - 1)));
    try {
      const direct = await runBattle(manifest);
      const results = await Promise.all(
        Array.from({ length: pool.workers }, () =>
          pool.run(manifest, DEFAULT_BUDGET, async () => {}, new AbortController().signal),
        ),
      );
      expect(results.map((r) => r.result)).toEqual(
        Array.from({ length: pool.workers }, () => direct.result),
      );
      const controller = new AbortController();
      let last: StreamRecord | undefined;
      const interrupted = pool.run(
        manifest,
        DEFAULT_BUDGET,
        async (batch) => {
          last = batch[0] as StreamRecord;
          controller.abort();
        },
        controller.signal,
      );
      await expect(interrupted).rejects.toThrow(/abort/i);
      expect(last?.kind).toBe('initial');
      const replacement = await pool.run(
        manifest,
        DEFAULT_BUDGET,
        async () => {},
        new AbortController().signal,
      );
      expect(replacement.result).toEqual(direct.result);
    } finally {
      await pool.close();
    }
  });
});

afterEach(() => vi.restoreAllMocks());

it('captures real final synchronous collections without waiting for observer delivery', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '-e',
      `
    import { observeGc } from ${JSON.stringify(new URL('./gc-observation.ts', import.meta.url).href)};
    const result = await observeGc(true, async () => {
      global.gc();
      global.gc();
      return { observation: { prior: 7 } };
    });
    console.log(JSON.stringify(result.observation));
  `,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout) as Record<string, number>;
  expect(result.prior).toBe(7);
  expect(result.gcCount).toBeGreaterThanOrEqual(2);
  expect(result.gcDurationMs).toBeGreaterThan(0);
});

it('leaves unmeasured work alone and closes the native profiler after an exact failure', async () => {
  const start = vi.spyOn(GCProfiler.prototype, 'start');
  const stop = vi.spyOn(GCProfiler.prototype, 'stop');
  const value = { observation: { prior: 7 } };
  expect(await observeGc(false, async () => value)).toBe(value);
  expect(start).not.toHaveBeenCalled();
  const failure = new Error('initialization failed');
  await expect(
    observeGc(true, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(stop).toHaveBeenCalledTimes(1);
  await observeGc(true, async () => value);
  expect(stop).toHaveBeenCalledTimes(2);
});

it('converts native microseconds to milliseconds while retaining existing observations', async () => {
  vi.spyOn(GCProfiler.prototype, 'start').mockImplementation(() => {});
  vi.spyOn(GCProfiler.prototype, 'stop').mockReturnValue({
    statistics: [{ cost: 2000 }, { cost: 3500 }],
  } as ReturnType<GCProfiler['stop']>);
  const result = await observeGc(true, async () => ({ observation: {} }));
  expect(result.observation).toEqual({ gcCount: 2, gcDurationMs: 5.5 });
});
