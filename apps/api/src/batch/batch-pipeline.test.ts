import { expect, it, vi } from 'vite-plus/test';
import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import { ARTIFACT_RESERVATION_BYTES, canonicalJson } from '@fantasy/domain/spatial';
import { readdir } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { batchInput, batchSource } from '../../test-support/batches.ts';
import { withReplayDirectory } from '../../test-support/replays.ts';
import { BattleService } from '../jobs/battle-service.ts';
import { BattlePool } from '../jobs/worker-pool.ts';
import { Measurements } from '../measurements.ts';
import { openStore } from '../db/store.ts';
import { ArtifactStore } from '../replay/artifact-store.ts';
import { BattleBundles } from './battle-bundle.ts';
import { createBatchPlan } from './batch-plan.ts';
import { runBatch, reconcileBatch } from './batch-runner.ts';

function gate() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

function heldPublication(fail = false) {
  const entered = gate(),
    release = gate(),
    secondFinished = gate();
  const state = { submissions: 0, publications: 0, active: 0, peak: 0 };
  const originalSubmit = BattleService.prototype.submit,
    originalPublish = BattleBundles.prototype.publish;
  const submit = vi.spyOn(BattleService.prototype, 'submit').mockImplementation(async function (
    this: BattleService,
    ...args: Parameters<BattleService['submit']>
  ) {
    const job = await originalSubmit.apply(this, args);
    if (++state.submissions === 2)
      void this.wait(job.id).then(() => secondFinished.resolve(), secondFinished.reject);
    return job;
  });
  const publish = vi.spyOn(BattleBundles.prototype, 'publish').mockImplementation(async function (
    this: BattleBundles,
    ...args: Parameters<BattleBundles['publish']>
  ) {
    const ordinal = ++state.publications;
    state.peak = Math.max(state.peak, ++state.active);
    try {
      if (ordinal === 1) {
        entered.resolve();
        await release.promise;
        if (fail) throw new Error('Injected durable publication failure');
      }
      return await originalPublish.apply(this, args);
    } finally {
      state.active--;
    }
  });
  return {
    entered: entered.promise,
    secondFinished: secondFinished.promise,
    release: () => release.resolve(),
    state,
    restore: () => {
      submit.mockRestore();
      publish.mockRestore();
    },
  };
}

it.each([
  { workers: 1, window: 1 },
  ...Array.from({ length: Math.min(4, Math.max(1, availableParallelism() - 1)) }, (_, i) => ({
    workers: i + 1,
    window: 2,
  })),
])(
  'bounds all admitted results with $workers Workers and a $window-unit publication window',
  async ({ workers, window }) => {
    await withReplayDirectory(async (root) => {
      const plan = await createBatchPlan(
        {
          ...(await batchInput(6)),
          maxWorkBytes: (workers * 2 + window) * ARTIFACT_RESERVATION_BYTES,
        },
        batchSource,
      );
      const held = heldPublication(),
        measurement = new Measurements();
      const running = measurement.run(() => runBatch(plan, root, batchSource, { workers }));
      try {
        await held.entered;
        if (window === 2) await held.secondFinished;
        await setImmediate();
        expect(held.state.submissions).toBe(window);
        expect(held.state.publications).toBe(1);
        expect(measurement.report().capacitySampleMaxBytes['save.queueReservedBytes']).toBe(
          window * ARTIFACT_RESERVATION_BYTES,
        );
        held.release();
        const result = await running;
        expect(result.index.complete).toBe(true);
        expect(held.state.peak).toBe(1);
        expect(held.state.active).toBe(0);
        const report = measurement.report();
        expect(report.queues['save.publication']).toMatchObject({
          admitted: 6,
          maxPending: window,
        });
        expect(report.incompleteSpans).toBe(0);
        expect(
          await reconcileBatch(plan, [{ index: result.index, bundles: new BattleBundles(root) }]),
        ).toMatchObject({ complete: true, recorded: 6 });
      } finally {
        held.release();
        await running.catch(() => {});
        held.restore();
      }
    });
  },
  30_000,
);

it.each(['save failure', 'abort'] as const)(
  'stops new admission on %s, drains admitted saves and resumes without new attempts',
  async (mode) => {
    await withReplayDirectory(async (root) => {
      const plan = await createBatchPlan(await batchInput(6), batchSource),
        controller = new AbortController(),
        held = heldPublication(mode === 'save failure');
      const running = runBatch(plan, root, batchSource, { signal: controller.signal });
      try {
        await held.entered;
        await held.secondFinished;
        if (mode === 'abort') controller.abort();
        held.release();
        const stopped = await running;
        expect(held.state.submissions).toBe(2);
        expect(held.state.publications).toBe(2);
        expect(held.state.active).toBe(0);
        expect(stopped.index.complete).toBe(false);
        expect(stopped.index.slots.filter((s) => s.state === 'pending')).toHaveLength(4);
        expect(stopped.index.slots.filter((s) => s.state === 'complete')).toHaveLength(
          mode === 'save failure' ? 1 : 2,
        );
        const failed = stopped.index.slots.filter((s) => s.state === 'failed');
        expect(failed).toHaveLength(mode === 'save failure' ? 1 : 0);
        for (const slot of failed) {
          expect(slot.receipt).toBeNull();
          expect(await new BattleBundles(root).cached(slot.simulationHash)).toBeNull();
        }
        held.restore();
        const resumed = await runBatch(plan, root, batchSource);
        expect(resumed.index.complete).toBe(true);
        for (const slot of stopped.index.slots.filter((s) => s.receipt))
          expect(resumed.index.slots.find((s) => s.slotId === slot.slotId)?.receipt).toEqual(
            slot.receipt,
          );
        const store = openStore(join(root, '.work', 'database.sqlite'));
        try {
          expect(store.db.prepare('SELECT count(*) AS n FROM simulation_attempts').get()).toEqual({
            n: 6,
          });
          expect(
            store.db
              .prepare(
                "SELECT count(*) AS n FROM simulation_jobs WHERE state IN ('queued', 'running')",
              )
              .get(),
          ).toEqual({ n: 0 });
        } finally {
          store.close();
        }
      } finally {
        held.release();
        await running.catch(() => {});
        held.restore();
      }
    });
  },
  30_000,
);

it('copies each published replay under one manifest binding, not one per stored file', async () => {
  await withReplayDirectory(async (root) => {
    const plan = await createBatchPlan(await batchInput(2), batchSource);
    const bulk = vi.spyOn(ArtifactStore.prototype, 'files'),
      single = vi.spyOn(ArtifactStore.prototype, 'file');
    try {
      const { index } = await runBatch(plan, root, batchSource);
      expect(index.complete).toBe(true);
      const bundles = new BattleBundles(root);
      let stored = 0;
      for (const slot of index.slots) {
        const manifest = await bundles.manifest(slot.receipt!);
        stored += manifest.chunks.length + manifest.checkpoints.length;
      }
      // Each stored file is still read and checksummed; only the manifest is bound once.
      expect(stored).toBeGreaterThan(index.slots.length);
      expect(bulk).toHaveBeenCalledTimes(index.slots.length);
      expect(single).not.toHaveBeenCalled();
    } finally {
      bulk.mockRestore();
      single.mockRestore();
    }
  });
}, 30_000);

it('holds every unpublished result when the real output reservation is exhausted', async () => {
  await withReplayDirectory(async (root) => {
    const input = { ...(await batchInput(6)), estimatedBytesPerMatch: 1 };
    const initial = await createBatchPlan(input, batchSource);
    const plan = await createBatchPlan(
      { ...input, maxOutputBytes: 2_000_000 + Buffer.byteLength(canonicalJson(initial)) },
      batchSource,
    );
    const result = await runBatch(plan, root, batchSource);
    expect(result.index.complete).toBe(false);
    expect(result.index.slots.every((s) => s.receipt === null)).toBe(true);
    expect(result.index.slots.some((s) => s.reason.includes('Bundle storage limit exceeded'))).toBe(
      true,
    );
    expect(result.index.slots.some((s) => s.state === 'pending')).toBe(true);
    expect(await readdir(join(root, 'objects'))).toEqual([]);
    expect(await readdir(join(root, 'complete'))).toEqual([]);
    expect((await readdir(root)).some((name) => name.startsWith('.bundle-staging-'))).toBe(false);
    expect(await new BattleBundles(root, plan.maxOutputBytes).storedBytes()).toBeLessThanOrEqual(
      plan.maxOutputBytes,
    );
  });
}, 30_000);

it('finishes an admitted calculation after a publication failure without cancelling its attempt', async () => {
  await withReplayDirectory(async (root) => {
    const plan = await createBatchPlan(await batchInput(6), batchSource),
      held = heldPublication(true),
      computing = gate(),
      finish = gate();
    const original = BattlePool.prototype.run;
    let runs = 0,
      admittedSignal: AbortSignal | undefined;
    const pool = vi.spyOn(BattlePool.prototype, 'run').mockImplementation(async function (
      this: BattlePool,
      ...args: Parameters<BattlePool['run']>
    ) {
      if (++runs === 2) {
        admittedSignal = args[3];
        computing.resolve();
        await finish.promise;
      }
      return original.apply(this, args);
    });
    const cancelled = vi.spyOn(BattleService.prototype, 'cancel');
    const running = runBatch(plan, root, batchSource, { workers: 2 });
    try {
      await held.entered;
      await computing.promise;
      held.release();
      await setImmediate();
      expect(admittedSignal?.aborted).toBe(false);
      expect(cancelled).not.toHaveBeenCalled();
      finish.resolve();
      const stopped = await running;
      expect(held.state.submissions).toBe(2);
      expect(stopped.index.slots.filter((s) => s.state === 'failed')).toHaveLength(1);
      expect(stopped.index.slots.filter((s) => s.state === 'complete')).toHaveLength(1);
      expect(stopped.index.slots.filter((s) => s.state === 'pending')).toHaveLength(4);
      expect(cancelled).not.toHaveBeenCalled();
      held.restore();
      pool.mockRestore();
      const resumed = await runBatch(plan, root, batchSource, { workers: 2 });
      expect(resumed.index.complete).toBe(true);
      const store = openStore(join(root, '.work', 'database.sqlite'));
      try {
        expect(store.db.prepare('SELECT count(*) AS n FROM simulation_attempts').get()).toEqual({
          n: 6,
        });
      } finally {
        store.close();
      }
    } finally {
      held.release();
      finish.resolve();
      await running.catch(() => {});
      held.restore();
      pool.mockRestore();
      cancelled.mockRestore();
    }
  });
}, 30_000);
