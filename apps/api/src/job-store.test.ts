import { describe, expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import { DEFAULT_BUDGET } from '@fantasy/domain/spatial';
import { runPreparedBattle } from '@fantasy/engine/spatial';
import { JobStore, JOB_LIMITS } from './job-store.ts';
import { openStore } from './store.ts';
import { withJobs, artifactFor } from '../test-support/jobs.ts';
import { withReplayDirectory } from '../test-support/replays.ts';

describe('persistent simulation job ownership', () => {
  it('keeps persisted capacity, attempt and progress boundaries aligned with the existing DB', async () => {
    await withJobs(async ({ store, jobs, submit }) => {
      const job = submit('limits'),
        claim = jobs.claim(100)!;
      const attempts = store.db.prepare('UPDATE simulation_jobs SET max_attempts=? WHERE id=?');
      attempts.run(3, job.id);
      expect(() => attempts.run(4, job.id)).toThrow(/job_attempt_limit/);
      jobs.progress(claim, 6000);
      expect(() => jobs.progress(claim, 6001)).toThrow(/attempt_progress/);
      jobs.cancel(job.id, 101);
      expect(jobs.saveDiagnostic(claim, { ...artifactFor(claim), bytes: 20_971_520 })).toBe(true);
      expect(() =>
        store.db
          .prepare('UPDATE replay_artifacts SET bytes=? WHERE id=?')
          .run(20_971_521, artifactFor(claim).id),
      ).toThrow(/artifact_bytes/);
    });
  });
  it('scopes idempotency separately from simulation identity and rejects changed requests', async () => {
    await withJobs(async ({ jobs, submit }) => {
      const one = submit('same');
      expect(submit('same')).toEqual(one);
      expect(() => submit('same', { ...DEFAULT_BUDGET, maxBytes: 1 })).toThrow(/Idempotency/);
      const two = submit('other');
      expect(two.id).not.toBe(one.id);
      expect(two.simulationHash).toBe(one.simulationHash);
      const claim = jobs.claim(100)!;
      expect(jobs.heartbeat(claim, 101)).toBe(true);
      expect(jobs.heartbeat({ ...claim, attempt: { ...claim.attempt, token: 'wrong' } }, 101)).toBe(
        false,
      );
    });
  });
  it('recovers lease expiry across connections and fences stale or duplicate completion', async () => {
    await withReplayDirectory(async (root) =>
      withJobs(
        async ({ store, jobs, submit, result }) => {
          const job = submit('restart'),
            first = jobs.claim(100)!;
          const reopened = openStore(join(root, 'jobs.sqlite'));
          try {
            const other = new JobStore(reopened);
            expect(other.claim(101)).toBeNull();
            expect(other.recover(100 + JOB_LIMITS.leaseMs)).toBe(1);
            const second = other.claim(100 + JOB_LIMITS.leaseMs)!;
            expect(second.attempt.token).not.toBe(first.attempt.token);
            expect(jobs.complete(first, 'old', result, artifactFor(first), 10100).accepted).toBe(
              false,
            );
            expect(other.complete(second, 'new', result, artifactFor(second), 10101).accepted).toBe(
              true,
            );
            expect(
              other.complete(second, 'duplicate', result, artifactFor(second), 10102).accepted,
            ).toBe(false);
            expect(jobs.get(job.id)?.resultId).toBe('new');
            expect(store.db.prepare('SELECT COUNT(*) AS n FROM battle_results').get()).toEqual({
              n: 1,
            });
          } finally {
            reopened.close();
          }
        },
        join(root, 'jobs.sqlite'),
      ),
    );
  });
  it.each(['cancel-first', 'complete-first'] as const)(
    'serializes %s without resurrecting a cancelled job',
    async (order) => {
      await withJobs(async ({ jobs, submit, result }) => {
        const job = submit('race'),
          claim = jobs.claim(100)!;
        if (order === 'cancel-first') jobs.cancel(job.id, 101);
        const completed = jobs.complete(claim, 'result', result, artifactFor(claim), 102);
        const cancelled = jobs.cancel(job.id, 103);
        expect(completed.accepted).toBe(order === 'complete-first');
        expect(cancelled.state).toBe(order === 'complete-first' ? 'completed' : 'cancelled');
        expect(jobs.canonical(job.simulationHash)?.id ?? null).toBe(
          order === 'complete-first' ? 'result' : null,
        );
      });
    },
  );
  it('retains truncation evidence and retries with a new immutable budget without poisoning cache', async () => {
    await withJobs(async ({ jobs, submit, battle, result }) => {
      const small = { ...DEFAULT_BUDGET, maxBytes: 1 },
        job = submit('budget', small),
        first = jobs.claim(100)!;
      const truncated = (await runPreparedBattle(battle, small)).result;
      expect(truncated.outcome.kind).toBe('truncated');
      jobs.complete(first, 'short', truncated, artifactFor(first), 101);
      expect(jobs.canonical(job.simulationHash)).toBeUndefined();
      jobs.retry(job.id, 1, DEFAULT_BUDGET, 102);
      expect(() => jobs.retry(job.id, 1, DEFAULT_BUDGET, 103)).toThrow(/cannot be retried/);
      const second = jobs.claim(104)!;
      jobs.complete(second, 'full', result, artifactFor(second), 105);
      expect(jobs.canonical(job.simulationHash)?.id).toBe('full');
      expect(jobs.attempts(job.id).map((a) => JSON.parse(a.budgetJson).maxBytes)).toEqual([
        1,
        DEFAULT_BUDGET.maxBytes,
      ]);
      expect(() => jobs.retry(job.id, 2, DEFAULT_BUDGET, 106)).toThrow(/cannot be retried/);
    });
  });
  it('quarantines disagreeing definitive results and keeps immutable result records', async () => {
    await withJobs(async ({ jobs, store, submit, result }) => {
      const job = submit('first');
      submit('second');
      const first = jobs.claim(100)!;
      jobs.complete(first, 'one', result, artifactFor(first), 101);
      const second = jobs.claim(102)!;
      expect(
        jobs.complete(
          second,
          'two',
          { ...result, eventHash: `sha256:${'b'.repeat(64)}` },
          artifactFor(second),
          103,
        ),
      ).toEqual({ accepted: true, conflict: true });
      expect(jobs.canonical(job.simulationHash)).toBeUndefined();
      expect(jobs.artifact(artifactFor(first).id)?.state).toBe('quarantined');
      expect(jobs.get(second.job.id)?.state).toBe('failed');
      expect(() =>
        store.db.prepare("UPDATE battle_results SET result_hash='edited'").run(),
      ).toThrow(/immutable/);
      expect(() => store.db.prepare('DELETE FROM battle_results').run()).toThrow(
        /cannot be deleted/,
      );
    });
  });
  it('bounds recovered attempts, preserves diagnostics and excludes corrupt artifacts from cache', async () => {
    await withJobs(async ({ jobs, submit, result }) => {
      const job = submit('expires');
      for (let i = 0; i < JOB_LIMITS.maxAttempts; i++) {
        const now = 100 + i * JOB_LIMITS.leaseMs,
          claim = jobs.claim(now)!;
        jobs.recover(now + JOB_LIMITS.leaseMs);
        expect(jobs.heartbeat(claim, now + JOB_LIMITS.leaseMs)).toBe(false);
        expect(jobs.saveDiagnostic(claim, artifactFor(claim))).toBe(true);
        expect(jobs.saveDiagnostic(claim, artifactFor(claim))).toBe(false);
      }
      expect(jobs.get(job.id)?.state).toBe('failed');
      expect(jobs.claim(40000)).toBeNull();
      expect(() => jobs.retry(job.id, 3, DEFAULT_BUDGET, 40000)).toThrow();
      submit('healthy');
      const claim = jobs.claim(50000)!;
      jobs.complete(claim, 'ready', result, artifactFor(claim), 50001);
      expect(jobs.canonical(job.simulationHash)?.id).toBe('ready');
      jobs.markArtifact(artifactFor(claim).id, 'corrupt');
      expect(jobs.canonical(job.simulationHash)).toBeUndefined();
    });
  });
  it('rejects overfull queues before any additional job is inserted', async () => {
    await withJobs(async ({ store, submit }) => {
      for (let i = 0; i < JOB_LIMITS.queued; i++) submit(`request-${i}`);
      expect(() => submit('overflow')).toThrow(/queue capacity/);
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM simulation_jobs').get()).toEqual({
        n: JOB_LIMITS.queued,
      });
    });
  });
  it('recovers a lost canonical artifact only with a matching immutable definitive result', async () => {
    await withJobs(async ({ jobs, submit, result }) => {
      const job = submit('original'),
        first = jobs.claim(100)!;
      jobs.complete(first, 'original-result', result, artifactFor(first), 101);
      jobs.markArtifact(artifactFor(first).id, 'missing');
      submit('repair');
      const repair = jobs.claim(102)!;
      jobs.complete(repair, 'repair-result', result, artifactFor(repair), 103);
      expect(jobs.canonical(job.simulationHash)?.id).toBe('repair-result');
      expect(jobs.canonicalRecord(job.simulationHash)?.id).toBe('original-result');
      submit('disagreement');
      const third = jobs.claim(104)!;
      jobs.complete(
        third,
        'conflict',
        { ...result, eventHash: `sha256:${'c'.repeat(64)}` },
        artifactFor(third),
        105,
      );
      expect(jobs.canonical(job.simulationHash)).toBeUndefined();
      expect(jobs.artifact(artifactFor(repair).id)?.state).toBe('quarantined');
    });
  });
  it('does not let late diagnostics consume reservations belonging to admitted jobs', async () => {
    await withJobs(async ({ store, submit, result }) => {
      const jobs = new JobStore(store, { ...JOB_LIMITS, storageBytes: 20 * 1024 ** 2 });
      const old = submit('old'),
        claim = jobs.claim(100)!;
      jobs.cancel(old.id, 101);
      const pending = submit('reserved');
      expect(() => jobs.saveDiagnostic(claim, artifactFor(claim))).toThrow(/storage capacity/);
      expect(jobs.artifact(artifactFor(claim).id)).toBeUndefined();
      const live = jobs.claim(102)!;
      expect(live.job.id).toBe(pending.id);
      expect(jobs.complete(live, 'fits', result, artifactFor(live), 103).accepted).toBe(true);
    });
  });
});
