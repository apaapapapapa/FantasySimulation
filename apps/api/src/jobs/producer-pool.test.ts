import { expect, it, vi } from 'vite-plus/test';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { DEFAULT_BUDGET } from '@fantasy/domain/spatial';
import { batchInput, batchSource } from '../../test-support/batches.ts';
import { recordedBattle, withReplayDirectory } from '../../test-support/replays.ts';
import { createBatchPlan } from '../batch/batch-plan.ts';
import { runBatch, reconcileBatch } from '../batch/batch-runner.ts';
import { BattleBundles } from '../batch/battle-bundle.ts';
import { BattlePool } from './worker-pool.ts';

it('shares one thread and a bounded wait slot across calculation and full verification', async () => {
  await withReplayDirectory(async (root) => {
    const { manifest } = await recordedBattle(root, 20),
      pool = new BattlePool(1);
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const calculation = pool.run(
        manifest.input,
        DEFAULT_BUDGET,
        async () => {
          entered();
          await resume;
        },
        new AbortController().signal,
      );
      await held;
      const verification = pool.verify(join(root, manifest.id), manifest, true);
      expect(pool.pool.queueSize).toBe(1);
      expect(pool.pool.threads).toHaveLength(1);
      await expect(pool.verify(join(root, manifest.id), manifest, true)).rejects.toThrow(/queue/i);
      release();
      const first = await calculation;
      await verification;
      const next = await pool.run(
        manifest.input,
        DEFAULT_BUDGET,
        async () => {},
        new AbortController().signal,
      );
      expect(next.result).toEqual(first.result);
      expect(next.metrics.threadId).toBe(first.metrics.threadId);
      expect(next.metrics.cold).toBe(false);
      expect(pool.pool.threads).toHaveLength(1);
    } finally {
      release();
      await pool.close();
    }
  });
}, 30000);

it('rejects a terminated verifier before publishing a durable bundle or success pointer', async () => {
  await withReplayDirectory(async (root) => {
    const plan = await createBatchPlan(await batchInput(1), batchSource),
      pool = new BattlePool(1),
      verify = pool.verify.bind(pool);
    vi.spyOn(pool, 'verify').mockImplementation(async (...args) => {
      // The task is really submitted, then its owning pool terminates while it is in flight.
      await Promise.all([verify(...args), pool.close()]);
    });
    try {
      const { index } = await runBatch(plan, root, batchSource, { pool });
      expect(index.complete).toBe(false);
      expect(index.slots[0]).toMatchObject({ state: 'failed', receipt: null, reused: false });
      expect(await readdir(join(root, 'objects'))).toEqual([]);
      expect(await readdir(join(root, 'complete'))).toEqual([]);
      expect((await readdir(root)).some((name) => name.startsWith('.bundle-staging-'))).toBe(false);
    } finally {
      await pool.close();
    }
  });
}, 30000);

it('leaves a borrowed pool alive after each drained batch and closes only at its owner', async () => {
  await withReplayDirectory(async (root) => {
    const plan = await createBatchPlan(await batchInput(1), batchSource),
      pool = new BattlePool(1),
      close = vi.spyOn(pool, 'close'),
      run = vi.spyOn(pool, 'run');
    try {
      for (const suffix of ['first', 'second']) {
        const directory = join(root, suffix);
        const { index } = await runBatch(plan, directory, batchSource, { pool });
        expect(index.slots[0]?.receipt).not.toBeNull();
        expect(
          (await reconcileBatch(plan, [{ bundles: new BattleBundles(directory), index }])).complete,
        ).toBe(true);
        expect(close).not.toHaveBeenCalled();
      }
      const [first, second] = await Promise.all(run.mock.results.map((r) => r.value));
      expect(second.metrics.threadId).toBe(first.metrics.threadId);
      expect(first.metrics.cold).toBe(true);
      expect(second.metrics.cold).toBe(false);
    } finally {
      await pool.close();
    }
    expect(close).toHaveBeenCalledTimes(1);
  });
}, 30000);
