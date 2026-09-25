import { describe, expect, it, vi } from 'vite-plus/test';
import { JobViewSchema, DEFAULT_BUDGET } from '@fantasy/domain/spatial';
import { withRuntime } from '../test-support/runtime.ts';
import { createApp } from './app.ts';
import { JobStore } from './job-store.ts';

describe('shared staged battle admission', { timeout: 30_000 }, () => {
  it.each([false, true])('waits for retry capacity and respects abort=%s', async (abortWaiting) => {
    await withRuntime(
      async ({ runtime, spec, jobs }) => {
        const previous = await runtime.submit(spec, 'retry-contention', 'retry');
        const cancelled = runtime.cancel(previous.id);
        await runtime.wait(previous.id);
        // Keep the competing request queued until this test explicitly releases capacity.
        const claim = vi.spyOn(JobStore.prototype, 'claim').mockReturnValue(null);
        let notifyAttempt!: () => void;
        const attempted = new Promise<void>((resolve) => {
          notifyAttempt = resolve;
        });
        const originalRetry = runtime.retry.bind(runtime);
        const retry = vi.spyOn(runtime, 'retry').mockImplementation(async (...args) => {
          try {
            return await originalRetry(...args);
          } finally {
            notifyAttempt();
          }
        });
        const controller = new AbortController();
        const stream = runtime.runMany([{ key: 'retry', spec }], 'retry-contention', {
          retryFailed: true,
          signal: controller.signal,
        });
        try {
          const blocker = await runtime.submit(spec, 'competing', 'queued');
          const next = stream.next();
          await attempted;
          expect(retry).toHaveBeenCalledTimes(1);
          expect(jobs.get(previous.id)?.state).toBe('cancelled');
          if (abortWaiting) controller.abort(new Error('Stop waiting'));
          claim.mockRestore();
          runtime.cancel(blocker.id);
          const result = (await next).value!;
          if (abortWaiting) {
            expect(result.job).toBeNull();
            expect(result.error).toMatchObject({ message: 'Stop waiting' });
            expect(jobs.get(previous.id)?.attempts).toBe(cancelled.attempts);
          } else {
            expect(result.error).toBeNull();
            expect(result.job?.state).toBe('completed');
            expect(result.job?.attempts).toBe(cancelled.attempts + 1);
          }
        } finally {
          claim.mockRestore();
          retry.mockRestore();
          await stream.return(undefined);
        }
      },
      { queueLimit: 1 },
    );
  });
  it('waits for queue capacity, shares HTTP results and preserves per-key failures', async () => {
    await withRuntime(
      async ({ runtime, store, spec }) => {
        const running = await runtime.submit(spec, 'other-client', 'running');
        const queued = await runtime.submit(spec, 'other-client', 'queued');
        const complete = [];
        for await (const result of runtime.runMany(
          [
            { key: 'one', spec },
            { key: 'two', spec },
          ],
          'stage',
        ))
          complete.push(result);
        expect(complete.map((r) => r.job?.state)).toEqual(['completed', 'completed']);
        expect((await runtime.wait(running.id)).state).toBe('completed');
        expect((await runtime.wait(queued.id)).state).toBe('completed');
        const app = createApp(store, false, runtime);
        try {
          const invalid = structuredClone(spec);
          invalid.participants[0].position.x = 1_000_000;
          const response = await app.inject({
            method: 'POST',
            url: '/api/battle-jobs/staged',
            headers: { 'x-client-id': 'stream' },
            payload: {
              jobs: [
                { key: 'valid', spec },
                { key: 'invalid', spec: invalid },
                { key: 'last', spec },
              ],
            },
          });
          expect(response.statusCode).toBe(200);
          expect(response.headers['content-type']).toContain('application/x-ndjson');
          const rows = response.body
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          expect(rows.map((r) => r.key)).toEqual(['valid', 'invalid', 'last']);
          expect(JobViewSchema.parse(rows[0].job).state).toBe('completed');
          expect(rows[1]).toEqual({
            key: 'invalid',
            job: null,
            error: 'Job could not be admitted or completed',
          });
          expect(JobViewSchema.parse(rows[2].job).state).toBe('completed');
          const oversized = await app.inject({
            method: 'POST',
            url: '/api/battle-jobs/staged',
            headers: { 'x-client-id': 'stream' },
            payload: { jobs: Array.from({ length: 101 }, () => ({ key: 'overflow', spec })) },
          });
          expect(oversized.statusCode).toBe(400);
        } finally {
          await app.close();
        }
      },
      { queueLimit: 2 },
    );
  });
  it('aborts admission and releases a queued waiter without starting additional jobs', async () => {
    await withRuntime(
      async ({ runtime, spec, jobs }) => {
        const first = await runtime.submit(spec, 'blocking', 'one');
        const second = await runtime.submit(spec, 'blocking', 'two');
        const abort = new AbortController();
        const stream = runtime.runMany(
          [
            { key: 'waiting', spec },
            { key: 'never', spec },
          ],
          'aborted',
          { signal: abort.signal },
        );
        const reading = stream.next();
        abort.abort(new Error('Stopped by caller'));
        await reading;
        await stream.return(undefined);
        expect(jobs.request('aborted', 'never')).toBeUndefined();
        runtime.cancel(first.id);
        runtime.cancel(second.id);
      },
      { queueLimit: 2 },
    );
  });
  it('rejects mismatched planned identity before admission and cancels a timed-out waiter', async () => {
    await withRuntime(async ({ runtime, jobs, spec }) => {
      const wrong = runtime.runMany(
        [{ key: 'wrong', spec, simulationHash: 'sha256:' + '0'.repeat(64) }],
        'plan',
      );
      expect((await wrong.next()).value?.job).toBeNull();
      expect(jobs.request('plan', 'wrong')).toBeUndefined();
      await wrong.return(undefined);
      const wait = vi.spyOn(runtime, 'wait').mockRejectedValueOnce(new Error('Job wait timeout'));
      try {
        const timed = runtime.runMany([{ key: 'timeout', spec }], 'plan');
        expect((await timed.next()).value?.error).toMatchObject({ message: 'Job wait timeout' });
        expect(jobs.request('plan', 'timeout')?.state).toBe('cancelled');
        await timed.return(undefined);
      } finally {
        wait.mockRestore();
      }
    });
  });
  it('uses the server retry permission for failed jobs and does not retry a definitive result', async () => {
    await withRuntime(async ({ runtime, spec }) => {
      const done = await runtime.wait((await runtime.submit(spec, 'retry-stage', 'one')).id);
      const stream = runtime.runMany(
        [{ key: 'one', spec, budget: DEFAULT_BUDGET }],
        'retry-stage',
        { retryFailed: true },
      );
      const resumed = await stream.next();
      expect(resumed.value?.job?.id).toBe(done.id);
      expect(resumed.value?.job?.attempts).toBe(done.attempts);
      await stream.return(undefined);
    });
  });
});
