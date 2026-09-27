import { expect, it, vi } from 'vite-plus/test';
import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import { ARTIFACT_RESERVATION_BYTES, canonicalJson } from '@fantasy/domain/spatial';
import { readdir } from 'node:fs/promises';
import { batchInput, batchSource } from '../../test-support/batches.ts';
import { withReplayDirectory } from '../../test-support/replays.ts';
import { BattleService } from '../jobs/battle-service.ts';
import { Measurements } from '../measurements.ts';
import { openStore } from '../db/store.ts';
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

it.each([1, 2])(
  'bounds the publication window to %i with work reservations and serial durable commits',
  async (window) => {
    await withReplayDirectory(async (root) => {
      const plan = await createBatchPlan(
        { ...(await batchInput(6)), maxWorkBytes: (2 + window) * ARTIFACT_RESERVATION_BYTES },
        batchSource,
      );
      const held = heldPublication(),
        measurement = new Measurements();
      const running = measurement.run(() => runBatch(plan, root, batchSource));
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
