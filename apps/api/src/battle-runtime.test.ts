import { describe, expect, it } from 'vite-plus/test';
import { mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DEFAULT_BUDGET, actorSeed, SpecInputSchema } from '@fantasy/domain/spatial';
import { withRuntime } from '../test-support/runtime.ts';
import { BattleRuntime } from './battle-runtime.ts';
import { openStore, jsonValue } from './store.ts';
import { readReplayManifest } from './replay-reader.ts';
import { createApp } from './app.ts';
import { battleSpecs } from './db/schema.ts';

describe('persistent Worker/API orchestration', () => {
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
          await expect(BattleRuntime.open(fresh, bad)).rejects.toThrow(/nonempty|another database/);
          const corrected = await BattleRuntime.open(fresh, join(directory, 'corrected'));
          await corrected.close();
        } finally {
          fresh.close();
        }
      });
    },
  );
  it('reclaims an expired attempt after a real coordinator process exits abruptly', async () => {
    await withRuntime(async ({ runtime, store, spec, filename, root, directory }) => {
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
      const next = await BattleRuntime.open(store, root);
      try {
        expect((await next.wait(id)).state).toBe('completed');
        expect(next.jobs.attempts(id).map((a) => a.state)).toEqual(['expired', 'completed']);
      } finally {
        await next.close();
      }
    });
  });
  it('executes real saved revisions, reuses only verified definitive results, and rejects corrupt cache', async () => {
    await withRuntime(async ({ runtime, spec, root }) => {
      const first = await runtime.submit(spec, 'client', 'one');
      expect((await runtime.submit(spec, 'client', 'one')).id).toBe(first.id);
      await expect(
        runtime.submit(spec, 'client', 'one', { ...DEFAULT_BUDGET, maxBytes: 1 }),
      ).rejects.toThrow(/Idempotency/);
      const done = await runtime.wait(first.id);
      expect(done.state).toBe('completed');
      expect(runtime.jobs.attempts(first.id)).toHaveLength(1);
      const cached = await runtime.submit(spec, 'client', 'two');
      expect(cached.resultId).toBe(done.resultId);
      expect(cached.attempts).toBe(0);
      const result = runtime.jobs.result(done.resultId!)!;
      const replay = await runtime.artifacts.verified(result.replayId);
      const chunk = replay.chunks[0]!;
      await writeFile(join(root, replay.id, chunk.file), 'corrupt');
      await expect(runtime.submit(spec, 'client', 'three')).rejects.toThrow(/corrupt/);
      expect(runtime.jobs.artifact(replay.id)?.state).toBe('corrupt');
      expect(runtime.jobs.canonical(result.simulationHash)).toBeUndefined();
      expect(runtime.jobs.request('client', 'three')).toBeUndefined();
      const repair = await runtime.recoverReplay(result.id, 'repair', 'one', DEFAULT_BUDGET);
      expect((await runtime.wait(repair.id)).state).toBe('completed');
      const restored = await runtime.submit(spec, 'client', 'four');
      expect(restored.attempts).toBe(0);
      expect(restored.resultId).not.toBe(result.id);
      expect(runtime.jobs.result(restored.resultId!)?.resultHash).toBe(result.resultHash);
    });
  });
  it('retries truncation with a larger budget and keeps attempts, progress and compressed endpoint bytes', async () => {
    await withRuntime(async ({ runtime, spec, store }) => {
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
        const id: string = submitted.json().job.id;
        const truncated = await runtime.wait(id);
        expect(jsonValue(runtime.jobs.result(truncated.resultId!)!.resultJson)).toMatchObject({
          outcome: { kind: 'truncated' },
        });
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
        const manifest = await runtime.artifacts.verified(response.json().replayId);
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
  it('does not resurrect cancellation and records a timeout as failure, never as a game draw', async () => {
    await withRuntime(async ({ runtime, spec }) => {
      const job = await runtime.submit(spec, 'cancel', 'one');
      runtime.cancel(job.id);
      const done = await runtime.wait(job.id);
      expect(done.state).toBe('cancelled');
      expect(done.resultId).toBeNull();
      expect(runtime.jobs.canonical(done.simulationHash)).toBeUndefined();
    });
    await withRuntime(
      async ({ runtime, spec, root }) => {
        const job = await runtime.submit(spec, 'timeout', 'one');
        const done = await runtime.wait(job.id);
        expect(done.state).toBe('failed');
        expect(done.error).toMatch(/timeout/);
        expect(done.resultId).toBeNull();
        const attempt = runtime.jobs.attempts(job.id)[0]!;
        expect(attempt.replayId).not.toBeNull();
        expect((await readReplayManifest(root, attempt.replayId!)).end.kind).toBe('failed');
      },
      { timeoutMs: 1 },
    );
  });
  it('reopens persisted results, rejects concurrent owners, removes only unreferenced generated files, and holds missing artifacts', async () => {
    await withRuntime(async ({ runtime, spec, store, filename, root }) => {
      const job = await runtime.submit(spec, 'restart', 'one');
      const done = await runtime.wait(job.id),
        result = runtime.jobs.result(done.resultId!)!;
      await expect(BattleRuntime.open(store, root)).rejects.toThrow(/coordinator/);
      await runtime.close();
      await mkdir(join(root, `.staging-${randomUUID()}`));
      await mkdir(join(root, randomUUID()));
      await mkdir(join(root, 'user-notes'));
      const unrelated = [
        'a'.repeat(36),
        '.staging-' + 'b'.repeat(36),
        '00000000-0000-0000-0000-000000000000',
      ];
      for (const name of unrelated) await mkdir(join(root, name));
      const reopened = openStore(filename),
        next = await BattleRuntime.open(reopened, root);
      try {
        expect(next.owner.removed).toBe(2);
        expect(await readdir(root)).toContain('user-notes');
        for (const name of unrelated) expect(await readdir(root)).toContain(name);
        expect((await next.submit(spec, 'restart', 'two')).resultId).toBe(result.id);
        await rm(join(root, result.replayId), { recursive: true });
        await expect(next.artifacts.verified(result.replayId)).rejects.toThrow(/missing/);
        expect(next.jobs.artifact(result.replayId)?.state).toBe('missing');
      } finally {
        await next.close();
        reopened.close();
      }
    });
  });
});
