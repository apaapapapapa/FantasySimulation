import { setTimeout as delay } from 'node:timers/promises';
import { BattlePool } from './worker-pool.ts';
import { JobStore } from './job-store.ts';
import { describe, expect, it, vi } from 'vite-plus/test';
import { mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BUDGET,
  actorSeed,
  SpecInputSchema,
  type ReplayManifest,
} from '@fantasy/domain/spatial';
import { withRuntime } from '../test-support/runtime.ts';
import { BattleService } from './battle-service.ts';
import { openStore, jsonValue } from './store.ts';
import { readReplayManifest } from './replay-reader.ts';
import { createApp } from './app.ts';
import { battleSpecs } from './db/schema.ts';

// Several cases start/stop multiple real Workers and SQLite roots. Windows cold
// starts exceeded Vitest's 5s default; this bounds the integration, not game time.
describe('persistent Worker/API orchestration', { timeout: 30000 }, () => {
  it('notifies multiple completion waiters without polling and settles cancellation, timeout and shutdown', async () => {
    const latch = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const entered = latch(),
      release = latch();
    const run = vi.spyOn(BattlePool.prototype, 'run').mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      throw new Error('Controlled Worker failure');
    });
    try {
      await withRuntime(async ({ runtime, spec }) => {
        const first = await runtime.submit(spec, 'notifications', 'first');
        await entered.promise;
        const read = vi.spyOn(JobStore.prototype, 'get');
        try {
          const one = runtime.wait(first.id),
            two = runtime.wait(first.id);
          await delay(35);
          expect(read.mock.calls.filter(([id]) => id === first.id)).toHaveLength(2);
          await expect(runtime.wait(first.id, 1)).rejects.toThrow('Job wait timeout');
          const cancelled = await runtime.submit(spec, 'notifications', 'cancelled');
          const cancellation = runtime.wait(cancelled.id);
          runtime.cancel(cancelled.id);
          expect((await cancellation).state).toBe('cancelled');
          const queued = await runtime.submit(spec, 'notifications', 'shutdown');
          const shutdown = runtime.wait(queued.id);
          const closing = runtime.close();
          await expect(shutdown).rejects.toThrow('Runtime closed');
          release.resolve();
          const completed = await Promise.all([one, two]);
          expect(completed.map((job) => job.state)).toEqual(['failed', 'failed']);
          await closing;
        } finally {
          release.resolve();
          read.mockRestore();
        }
      });
    } finally {
      release.resolve();
      run.mockRestore();
    }
  });
  it('accepts an immediate retry after cancellation without overlapping attempts', async () => {
    await withRuntime(async ({ runtime, jobs, spec }) => {
      const first = await runtime.submit(spec, 'immediate-retry', 'one');
      const cancelled = runtime.cancel(first.id);
      expect(cancelled.state).toBe('cancelled');
      const requests = await Promise.allSettled([
        runtime.retry(first.id, cancelled.attempts, DEFAULT_BUDGET),
        runtime.retry(first.id, cancelled.attempts, DEFAULT_BUDGET),
      ]);
      expect(requests.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect((await runtime.wait(first.id)).state).toBe('completed');
      expect(jobs.attempts(first.id).map((a) => a.state)).toEqual(['cancelled', 'completed']);
    });
  });
  it('returns an actionable client error for out-of-bounds spawns without persisting a job', async () => {
    await withRuntime(async ({ runtime, jobs, store, spec }) => {
      const app = createApp(store, false, runtime);
      try {
        spec.participants[0].position.x = 1000000;
        const response = await app.inject({
          method: 'POST',
          url: '/api/battle-jobs',
          headers: { 'x-client-id': 'bounds', 'idempotency-key': 'invalid' },
          payload: { spec, budget: DEFAULT_BUDGET },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'Spawn body exceeds arena bounds' });
        expect(store.orm.select().from(battleSpecs).all()).toHaveLength(0);
        expect(jobs.request('POST/battle-jobs:bounds', 'invalid')).toBeUndefined();
      } finally {
        await app.close();
      }
    });
  });
  it.each([
    { options: { queueLimit: 1 }, reason: /queue capacity/ },
    { options: { storageBytes: 40 * 1024 ** 2 }, reason: /storage capacity/ },
  ])(
    'does not persist specifications rejected by admission: $reason',
    async ({ options, reason }) => {
      await withRuntime(
        async ({ runtime, store, spec }) => {
          const first = await runtime.submit(spec, 'capacity', 'accepted');
          for (const seed of [41, 42, 43])
            await expect(
              runtime.submit(
                SpecInputSchema.parse({
                  ...spec,
                  seed,
                  participants: spec.participants.map((p) => ({
                    ...p,
                    rngSeed: actorSeed(seed, p.rngStream),
                  })),
                }),
                'capacity',
                String(seed),
              ),
            ).rejects.toThrow(reason);
          expect(store.orm.select().from(battleSpecs).all()).toHaveLength(1);
          runtime.cancel(first.id);
          await runtime.wait(first.id);
        },
        options,
        6000,
      );
    },
  );
  it.each(['nonempty', 'foreign'])(
    'can correct a fresh database root after %s adoption fails',
    async (kind) => {
      await withRuntime(async ({ root, directory }) => {
        const fresh = openStore(join(directory, 'fresh.sqlite'));
        const bad = kind === 'foreign' ? root : join(directory, 'nonempty');
        if (kind === 'nonempty') {
          await mkdir(bad);
          await writeFile(join(bad, 'notes.txt'), 'keep');
        }
        try {
          await expect(BattleService.open(fresh, bad)).rejects.toThrow(/nonempty|another database/);
          const corrected = await BattleService.open(fresh, join(directory, 'corrected'));
          await corrected.close();
        } finally {
          fresh.close();
        }
      });
    },
  );
  it('reclaims an expired attempt after a real coordinator process exits abruptly', async () => {
    await withRuntime(async ({ runtime, jobs, store, spec, filename, root, directory }) => {
      await runtime.close();
      const input = join(directory, 'spec.json');
      await writeFile(input, JSON.stringify(spec));
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          fileURLToPath(new URL('../test-support/crash-coordinator.ts', import.meta.url)),
          filename,
          root,
          input,
        ],
        { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 },
      );
      expect(child.status, child.stderr).toBe(83);
      const id = child.stdout.trim();
      const next = await BattleService.open(store, root);
      try {
        expect((await next.wait(id)).state).toBe('completed');
        expect(jobs.attempts(id).map((a) => a.state)).toEqual(['expired', 'completed']);
      } finally {
        await next.close();
      }
    });
  });
  it('executes real saved revisions, reuses only verified definitive results, and rejects corrupt cache', async () => {
    await withRuntime(async ({ runtime, jobs, spec, root }) => {
      const first = await runtime.submit(spec, 'client', 'one');
      expect((await runtime.submit(spec, 'client', 'one')).id).toBe(first.id);
      await expect(
        runtime.submit(spec, 'client', 'one', { ...DEFAULT_BUDGET, maxBytes: 1 }),
      ).rejects.toThrow(/Idempotency/);
      const done = await runtime.wait(first.id);
      expect(done.state).toBe('completed');
      expect(jobs.attempts(first.id)).toHaveLength(1);
      const cached = await runtime.submit(spec, 'client', 'two');
      expect(cached.resultId).toBe(done.resultId);
      expect(cached.attempts).toBe(0);
      const result = jobs.result(done.resultId!)!;
      const replay = await runtime.replay(result.replayId);
      const chunk = replay.chunks[0]!;
      await writeFile(join(root, replay.id, chunk.file), 'corrupt');
      await expect(runtime.submit(spec, 'client', 'three')).rejects.toThrow(/corrupt/);
      expect(jobs.artifact(replay.id)?.state).toBe('corrupt');
      expect(jobs.canonical(result.simulationHash)).toBeUndefined();
      expect(jobs.request('client', 'three')).toBeUndefined();
      const repair = await runtime.recoverReplay(result.id, 'repair', 'one', DEFAULT_BUDGET);
      expect((await runtime.wait(repair.id)).state).toBe('completed');
      const restored = await runtime.submit(spec, 'client', 'four');
      expect(restored.attempts).toBe(0);
      expect(restored.resultId).not.toBe(result.id);
      expect(jobs.result(restored.resultId!)?.resultHash).toBe(result.resultHash);
    });
  });
  it('retries truncation with a larger budget and keeps attempts, progress and compressed endpoint bytes', async () => {
    await withRuntime(async ({ runtime, jobs, spec, store }) => {
      const app = createApp(store, false, runtime);
      try {
        // The fixture owns close order; inject needs no listening socket.
        const headers = { 'x-client-id': 'test', 'idempotency-key': 'small' };
        const submitted = await app.inject({
          method: 'POST',
          url: '/api/battle-jobs',
          headers,
          payload: { spec, budget: { ...DEFAULT_BUDGET, maxBytes: 1 } },
        });
        expect(submitted.statusCode).toBe(202);
        expect(submitted.json().job.allowedOperations).toEqual({ cancel: true, retry: false });
        const id: string = submitted.json().job.id;
        const truncated = await runtime.wait(id);
        expect(jsonValue(jobs.result(truncated.resultId!)!.resultJson)).toMatchObject({
          outcome: { kind: 'truncated' },
        });
        const retryState = await app.inject(`/api/battle-jobs/${id}`);
        expect(retryState.json().job.allowedOperations).toEqual({ cancel: false, retry: true });
        const retried = await app.inject({
          method: 'POST',
          url: `/api/battle-jobs/${id}/retry`,
          payload: { expectedAttempts: 1, budget: DEFAULT_BUDGET },
        });
        expect(retried.statusCode).toBe(202);
        const done = await runtime.wait(id);
        expect(done.state).toBe('completed');
        const status = await app.inject(`/api/battle-jobs/${id}`);
        expect(status.json().attempts.map((a: { state: string }) => a.state)).toEqual([
          'completed',
          'completed',
        ]);
        expect(status.json().attempts[1].token).toBeUndefined();
        expect(status.json().attempts[1].progressStep).toBe(50);
        const response = await app.inject(`/api/battle-results/${done.resultId}`);
        expect(response.statusCode).toBe(200);
        const manifest = await runtime.replay(response.json().replayId);
        const gzip = await app.inject(
          `/api/replays/${manifest.id}/files/${manifest.chunks[0]!.file}`,
        );
        expect(gzip.headers['content-type']).toBe('application/gzip');
        expect(gzip.headers['content-encoding']).toBeUndefined();
        expect([...gzip.rawPayload.subarray(0, 2)]).toEqual([31, 139]);
        expect(
          (await app.inject({ method: 'POST', url: '/api/battle-jobs', payload: { spec } }))
            .statusCode,
        ).toBe(400);
      } finally {
        await app.close();
      }
    });
  });
  it('serves one replay file for a seek without re-reading the others and holds a damaged one', async () => {
    await withRuntime(async ({ runtime, jobs, spec, store, root }) => {
      const app = createApp(store, false, runtime);
      try {
        const done = await runtime.wait((await runtime.submit(spec, 'seek', 'one')).id);
        const { replayId } = jobs.result(done.resultId!)!;
        const files = `/api/replays/${replayId}/files`;
        const opened = (await app.inject(`/api/replays/${replayId}`)).json<ReplayManifest>();
        const [chunk, checkpoint] = [opened.chunks[0]!, opened.checkpoints[0]!];
        await writeFile(join(root, replayId, chunk.file), 'damaged after opening');
        // Only the requested file is read; the damaged chunk is found when it is requested.
        const served = await app.inject(`${files}/${checkpoint.file}`);
        expect([served.statusCode, served.rawPayload.length]).toEqual([200, checkpoint.bytes]);
        expect((await app.inject(`${files}/chunk-99999.ndjson.gz`)).statusCode).toBe(404);
        const damaged = await app.inject(`${files}/${chunk.file}`);
        expect([damaged.statusCode, damaged.json().error]).toEqual([
          503,
          'Replay is corrupt; result held',
        ]);
        expect(jobs.artifact(replayId)?.state).toBe('corrupt');
        expect((await app.inject(`${files}/${checkpoint.file}`)).statusCode).toBe(503);
      } finally {
        await app.close();
      }
    });
  });
  it('does not resurrect cancellation and records a timeout as failure, never as a game draw', async () => {
    await withRuntime(async ({ runtime, jobs, spec }) => {
      const job = await runtime.submit(spec, 'cancel', 'one');
      runtime.cancel(job.id);
      const done = await runtime.wait(job.id);
      expect(done.state).toBe('cancelled');
      expect(done.resultId).toBeNull();
      expect(jobs.canonical(done.simulationHash)).toBeUndefined();
    });
    await withRuntime(
      async ({ runtime, jobs, spec, root }) => {
        const job = await runtime.submit(spec, 'timeout', 'one');
        const done = await runtime.wait(job.id);
        expect(done.state).toBe('failed');
        expect(done.error).toMatch(/timeout/);
        expect(done.resultId).toBeNull();
        const attempt = jobs.attempts(job.id)[0]!;
        expect(attempt.replayId).not.toBeNull();
        expect((await readReplayManifest(root, attempt.replayId!)).end.kind).toBe('failed');
      },
      { timeoutMs: 1 },
    );
  });
  it('reopens persisted results, rejects concurrent owners, removes only unreferenced generated files, and holds missing artifacts', async () => {
    await withRuntime(async ({ runtime, jobs, spec, store, filename, root }) => {
      const job = await runtime.submit(spec, 'restart', 'one');
      const done = await runtime.wait(job.id),
        result = jobs.result(done.resultId!)!;
      await expect(BattleService.open(store, root)).rejects.toThrow(/coordinator/);
      await runtime.close();
      const generated = [`.staging-${randomUUID()}`, randomUUID()];
      for (const name of generated) await mkdir(join(root, name));
      await mkdir(join(root, 'user-notes'));
      const unrelated = [
        'a'.repeat(36),
        '.staging-' + 'b'.repeat(36),
        '00000000-0000-0000-0000-000000000000',
      ];
      for (const name of unrelated) await mkdir(join(root, name));
      const reopened = openStore(filename),
        next = await BattleService.open(reopened, root);
      try {
        expect((await readdir(root)).filter((name) => generated.includes(name))).toEqual([]);
        expect(await readdir(root)).toContain('user-notes');
        for (const name of unrelated) expect(await readdir(root)).toContain(name);
        expect((await next.submit(spec, 'restart', 'two')).resultId).toBe(result.id);
        await rm(join(root, result.replayId), { recursive: true });
        await expect(next.replay(result.replayId)).rejects.toThrow(/missing/);
        expect(new JobStore(reopened).artifact(result.replayId)?.state).toBe('missing');
      } finally {
        await next.close();
        reopened.close();
      }
    });
  });
});
