import { describe, expect, it } from 'vite-plus/test';
import { availableParallelism } from 'node:os';
import { DEFAULT_BUDGET, type StreamRecord } from '@fantasy/domain/spatial';
import { runBattle } from '@fantasy/engine/spatial';
import { catalogManifest } from '@fantasy/samples';
import { BattlePool } from './worker-pool.ts';

describe('reused calculation Workers', () => {
  it('matches the engine pull stream and records backpressure, with no knowledge carried between matches', async () => {
    const manifest = await catalogManifest('archer', 'guardian', 'flat', 250);
    const direct = await runBattle(manifest),
      pool = new BattlePool(1);
    try {
      const records: unknown[] = [];
      const first = await pool.run(
        manifest,
        DEFAULT_BUDGET,
        async (batch) => {
          records.push(...batch);
        },
        new AbortController().signal,
      );
      expect(first.result).toEqual(direct.result);
      expect(records).toEqual(direct.records);
      const second = await pool.run(
        manifest,
        DEFAULT_BUDGET,
        async () => {},
        new AbortController().signal,
      );
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
