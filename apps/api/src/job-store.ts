import { canCancelJob, canRetryJob } from './job-transitions.ts';
import { ARTIFACT_RESERVATION_BYTES, MAX_JOB_ATTEMPTS } from '@fantasy/domain/spatial';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, lte, inArray, notInArray, count, sum } from 'drizzle-orm';
import {
  BudgetSchema,
  ResultSchema,
  canonicalJson,
  parseJson,
  type Budget,
  type BattleResult,
} from '@fantasy/domain/spatial';
import {
  attemptMetrics,
  battleResults,
  replayArtifacts,
  simulationAttempts,
  simulationJobs,
} from './db/schema.ts';
import { Store, StoreError, jsonValue } from './store.ts';
import { sha256 } from './replay-files.ts';

export type Job = typeof simulationJobs.$inferSelect;
export type Attempt = typeof simulationAttempts.$inferSelect;
export type Claim = { job: Job; attempt: Attempt };
export type StoredResult = typeof battleResults.$inferSelect;
export type StoredArtifact = typeof replayArtifacts.$inferInsert;
export const JOB_LIMITS = Object.freeze({
  queued: 128,
  maxAttempts: MAX_JOB_ATTEMPTS,
  leaseMs: 10_000,
  timeoutMs: 30_000,
  storageBytes: 16 * 1024 ** 3,
});

/** Short immediate transactions serialize claims/cancel/finish; calculation and file I/O stay outside. */
export class JobStore {
  constructor(
    readonly store: Store,
    readonly limits: { [K in keyof typeof JOB_LIMITS]: number } = JOB_LIMITS,
  ) {}
  request(clientId: string, key: string) {
    return this.store.orm
      .select()
      .from(simulationJobs)
      .where(and(eq(simulationJobs.clientId, clientId), eq(simulationJobs.idempotencyKey, key)))
      .get();
  }
  canonicalRecord(simulationHash: string) {
    return this.store.orm
      .select()
      .from(battleResults)
      .where(eq(battleResults.canonicalHash, simulationHash))
      .get();
  }
  progress(claim: Claim, progressStep: number, metrics?: unknown) {
    const owned = this.store.orm
      .select()
      .from(simulationAttempts)
      .where(
        and(
          eq(simulationAttempts.id, claim.attempt.id),
          eq(simulationAttempts.token, claim.attempt.token),
        ),
      )
      .get();
    if (!owned) throw new Error('Unknown attempt token');
    const data = {
      progressStep,
      ...(metrics === undefined ? {} : { metricsJson: canonicalJson(metrics) }),
    };
    this.store.orm
      .insert(attemptMetrics)
      .values({ attemptId: claim.attempt.id, ...data })
      .onConflictDoUpdate({ target: attemptMetrics.attemptId, set: data })
      .run();
  }
  metrics(attemptId: string) {
    return this.store.orm
      .select()
      .from(attemptMetrics)
      .where(eq(attemptMetrics.attemptId, attemptId))
      .get();
  }
  get(id: string) {
    return this.store.orm.select().from(simulationJobs).where(eq(simulationJobs.id, id)).get();
  }
  attempts(id: string) {
    return this.store.orm
      .select()
      .from(simulationAttempts)
      .where(eq(simulationAttempts.jobId, id))
      .orderBy(asc(simulationAttempts.number))
      .all();
  }
  result(id: string) {
    return this.store.orm.select().from(battleResults).where(eq(battleResults.id, id)).get();
  }
  artifact(id: string) {
    return this.store.orm.select().from(replayArtifacts).where(eq(replayArtifacts.id, id)).get();
  }
  canonical(simulationHash: string) {
    const original = this.canonicalRecord(simulationHash);
    if (!original || this.artifact(original.replayId)?.state === 'quarantined') return undefined;
    return this.store.orm
      .select({ result: battleResults })
      .from(battleResults)
      .innerJoin(replayArtifacts, eq(battleResults.replayId, replayArtifacts.id))
      .where(
        and(
          eq(battleResults.simulationHash, simulationHash),
          eq(battleResults.resultHash, original.resultHash),
          eq(replayArtifacts.state, 'ready'),
        ),
      )
      .orderBy(asc(battleResults.createdAt), asc(battleResults.id))
      .limit(1)
      .get()?.result;
  }
  markArtifact(id: string, state: 'missing' | 'corrupt') {
    this.store.orm
      .update(replayArtifacts)
      .set({ state })
      .where(and(eq(replayArtifacts.id, id), eq(replayArtifacts.state, 'ready')))
      .run();
  }
  private pending() {
    return this.store.orm
      .select({ value: count() })
      .from(simulationJobs)
      .where(inArray(simulationJobs.state, ['queued', 'running']))
      .get()!.value;
  }
  private checkCapacity() {
    const pending = this.pending();
    const bytes = Number(
      this.store.orm
        .select({ value: sum(replayArtifacts.bytes) })
        .from(replayArtifacts)
        .get()?.value ?? 0,
    );
    // Reserve one maximum-size artifact for each admitted outstanding job.
    if (pending >= this.limits.queued)
      throw new StoreError('queue-capacity', 'Job queue capacity exceeded');
    if (bytes + (pending + 1) * ARTIFACT_RESERVATION_BYTES > this.limits.storageBytes)
      throw new StoreError('storage-capacity', 'Replay storage capacity exceeded');
  }
  private insertArtifact(artifact: StoredArtifact, consumedReservations = 0) {
    const bytes = Number(
      this.store.orm
        .select({ value: sum(replayArtifacts.bytes) })
        .from(replayArtifacts)
        .get()?.value ?? 0,
    );
    if (
      bytes +
        artifact.bytes +
        Math.max(0, this.pending() - consumedReservations) * ARTIFACT_RESERVATION_BYTES >
      this.limits.storageBytes
    )
      throw new StoreError('storage-capacity', 'Replay storage capacity exceeded');
    this.store.orm.insert(replayArtifacts).values(artifact).run();
  }
  submit(
    input: {
      simulationHash: string;
      clientId: string;
      key: string;
      requestHash: string;
      budget: Budget;
      cachedResult?: StoredResult;
    },
    now = Date.now(),
  ) {
    const budget = parseJson(BudgetSchema, input.budget);
    return this.store.transaction(() => {
      const existing = this.store.orm
        .select()
        .from(simulationJobs)
        .where(
          and(
            eq(simulationJobs.clientId, input.clientId),
            eq(simulationJobs.idempotencyKey, input.key),
          ),
        )
        .get();
      if (existing) {
        if (existing.requestHash !== input.requestHash)
          throw new StoreError('conflict', 'Idempotency key belongs to another request');
        return existing;
      }
      const cached = input.cachedResult;
      if (
        cached &&
        (cached.simulationHash !== input.simulationHash ||
          this.canonical(input.simulationHash)?.id !== cached.id)
      )
        throw new StoreError('conflict', 'Cached result became unavailable');
      if (!cached) this.checkCapacity();
      const id = randomUUID();
      this.store.orm
        .insert(simulationJobs)
        .values({
          id,
          simulationHash: input.simulationHash,
          clientId: input.clientId,
          idempotencyKey: input.key,
          requestHash: input.requestHash,
          budgetJson: canonicalJson(budget),
          state: cached ? 'completed' : 'queued',
          attempts: 0,
          maxAttempts: JOB_LIMITS.maxAttempts,
          resultId: cached?.id ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return this.get(id)!;
    });
  }
  claim(
    now = Date.now(),
    leaseMs = JOB_LIMITS.leaseMs,
    excludedJobIds: string[] = [],
  ): Claim | null {
    return this.store.transaction(() => {
      const job = this.store.orm
        .select()
        .from(simulationJobs)
        .where(
          and(
            eq(simulationJobs.state, 'queued'),
            excludedJobIds.length ? notInArray(simulationJobs.id, excludedJobIds) : undefined,
          ),
        )
        .orderBy(asc(simulationJobs.createdAt), asc(simulationJobs.id))
        .limit(1)
        .get();
      if (!job) return null;
      if (job.attempts >= job.maxAttempts) throw new Error('Queued job exhausted attempt budget');
      const id = randomUUID(),
        token = randomUUID(),
        number = job.attempts + 1;
      this.store.orm
        .insert(simulationAttempts)
        .values({
          id,
          jobId: job.id,
          number,
          token,
          state: 'running',
          budgetJson: job.budgetJson,
          leaseUntil: now + leaseMs,
          startedAt: now,
        })
        .run();
      this.store.orm
        .update(simulationJobs)
        .set({
          state: 'running',
          attempts: number,
          currentAttemptId: id,
          updatedAt: now,
          error: null,
        })
        .where(and(eq(simulationJobs.id, job.id), eq(simulationJobs.state, 'queued')))
        .run();
      return { job: this.get(job.id)!, attempt: this.attempts(job.id).at(-1)! };
    });
  }
  private valid(claim: Claim, now: number) {
    const current = this.get(claim.job.id);
    if (current?.state !== 'running' || current.currentAttemptId !== claim.attempt.id) return false;
    return !!this.store.orm
      .select({ id: simulationAttempts.id })
      .from(simulationAttempts)
      .where(
        and(
          eq(simulationAttempts.id, claim.attempt.id),
          eq(simulationAttempts.token, claim.attempt.token),
          eq(simulationAttempts.state, 'running'),
          gt(simulationAttempts.leaseUntil, now),
        ),
      )
      .get();
  }
  heartbeat(claim: Claim, now = Date.now()) {
    return this.store.transaction(() => {
      if (!this.valid(claim, now)) return false;
      this.store.orm
        .update(simulationAttempts)
        .set({ leaseUntil: now + JOB_LIMITS.leaseMs })
        .where(eq(simulationAttempts.id, claim.attempt.id))
        .run();
      return true;
    });
  }
  recover(now = Date.now()) {
    return this.store.transaction(() => {
      const expired = this.store.orm
        .select()
        .from(simulationAttempts)
        .where(
          and(eq(simulationAttempts.state, 'running'), lte(simulationAttempts.leaseUntil, now)),
        )
        .all();
      for (const attempt of expired) {
        this.store.orm
          .update(simulationAttempts)
          .set({ state: 'expired', finishedAt: now, error: 'Worker lease expired' })
          .where(eq(simulationAttempts.id, attempt.id))
          .run();
        const job = this.get(attempt.jobId);
        if (job?.state === 'running' && job.currentAttemptId === attempt.id)
          this.store.orm
            .update(simulationJobs)
            .set({
              state: job.attempts < job.maxAttempts ? 'queued' : 'failed',
              currentAttemptId: null,
              updatedAt: now,
              error: 'Worker lease expired',
            })
            .where(eq(simulationJobs.id, job.id))
            .run();
      }
      return expired.length;
    });
  }
  cancel(id: string, now = Date.now()) {
    return this.store.transaction(() => {
      const job = this.get(id);
      if (!job) throw new StoreError('not-found', 'Job not found');
      if (!canCancelJob(job)) return job;
      this.store.orm
        .update(simulationJobs)
        .set({ state: 'cancelled', updatedAt: now, error: 'Cancelled by client' })
        .where(eq(simulationJobs.id, id))
        .run();
      if (job.currentAttemptId)
        this.store.orm
          .update(simulationAttempts)
          .set({ state: 'cancelled', finishedAt: now, error: 'Cancelled by client' })
          .where(eq(simulationAttempts.id, job.currentAttemptId))
          .run();
      return this.get(id)!;
    });
  }
  fail(claim: Claim, reason: string, now = Date.now()) {
    return this.store.transaction(() => {
      if (!this.valid(claim, now)) return false;
      this.store.orm
        .update(simulationAttempts)
        .set({ state: 'failed', finishedAt: now, error: reason.slice(0, 1000) })
        .where(eq(simulationAttempts.id, claim.attempt.id))
        .run();
      this.store.orm
        .update(simulationJobs)
        .set({ state: 'failed', updatedAt: now, error: reason.slice(0, 1000) })
        .where(eq(simulationJobs.id, claim.job.id))
        .run();
      return true;
    });
  }
  retryable(job: Job) {
    const result = job.resultId ? this.result(job.resultId) : undefined;
    const outcome = result
      ? parseJson(ResultSchema, jsonValue(result.resultJson)).outcome.kind
      : null;
    return canRetryJob(job, outcome);
  }
  retry(id: string, expectedAttempts: number, budget: Budget, now = Date.now()) {
    const parsed = parseJson(BudgetSchema, budget);
    return this.store.transaction(() => {
      const job = this.get(id);
      if (!job) throw new StoreError('not-found', 'Job not found');
      if (job.attempts !== expectedAttempts || !this.retryable(job))
        throw new StoreError('conflict', 'Job cannot be retried at this version');
      this.store.requireExecutableSpec(job.simulationHash);
      this.checkCapacity();
      this.store.orm
        .update(simulationJobs)
        .set({
          state: 'queued',
          budgetJson: canonicalJson(parsed),
          currentAttemptId: null,
          resultId: null,
          failureCode: null,
          updatedAt: now,
          error: null,
        })
        .where(eq(simulationJobs.id, id))
        .run();
      return this.get(id)!;
    });
  }
  complete(
    claim: Claim,
    resultId: string,
    result: BattleResult,
    artifact: StoredArtifact,
    now = Date.now(),
  ) {
    const parsed = parseJson(ResultSchema, result),
      encoded = canonicalJson(parsed),
      resultHash = sha256(encoded);
    if (
      parsed.simulationHash !== claim.job.simulationHash ||
      artifact.attemptId !== claim.attempt.id ||
      artifact.state !== 'ready'
    )
      throw new Error('Attempt result/artifact binding mismatch');
    return this.store.transaction(() => {
      if (!this.valid(claim, now)) return { accepted: false, conflict: false };
      const final = parsed.outcome.kind === 'win' || parsed.outcome.kind === 'draw';
      const existing = this.canonicalRecord(parsed.simulationHash);
      const conflict = final && !!existing && existing.resultHash !== resultHash;
      this.insertArtifact({ ...artifact, state: conflict ? 'quarantined' : 'ready' }, 1);
      this.store.orm
        .insert(battleResults)
        .values({
          id: resultId,
          simulationHash: parsed.simulationHash,
          canonicalHash: final && !existing ? parsed.simulationHash : null,
          attemptId: claim.attempt.id,
          resultHash,
          resultJson: encoded,
          replayId: artifact.id,
          createdAt: now,
        })
        .run();
      if (conflict)
        this.store.orm
          .update(replayArtifacts)
          .set({ state: 'quarantined' })
          .where(
            inArray(
              replayArtifacts.id,
              this.store.orm
                .select({ replayId: battleResults.replayId })
                .from(battleResults)
                .where(eq(battleResults.simulationHash, parsed.simulationHash)),
            ),
          )
          .run();
      this.store.orm
        .update(simulationAttempts)
        .set({
          state: conflict ? 'conflict' : 'completed',
          finishedAt: now,
          replayId: artifact.id,
          error: conflict ? 'Determinism violation' : null,
        })
        .where(eq(simulationAttempts.id, claim.attempt.id))
        .run();
      this.store.orm
        .update(simulationJobs)
        .set({
          state: conflict ? 'failed' : 'completed',
          resultId,
          failureCode: conflict ? 'determinism-violation' : null,
          error: conflict ? 'Determinism violation' : null,
          updatedAt: now,
        })
        .where(eq(simulationJobs.id, claim.job.id))
        .run();
      return { accepted: true, conflict };
    });
  }
  saveDiagnostic(claim: Claim, artifact: StoredArtifact) {
    return this.store.transaction(() => {
      const attempt = this.attempts(claim.job.id).find((a) => a.id === claim.attempt.id);
      if (
        !attempt ||
        attempt.token !== claim.attempt.token ||
        !['failed', 'cancelled', 'expired'].includes(attempt.state) ||
        attempt.replayId
      )
        return false;
      if (artifact.attemptId !== attempt.id || artifact.state !== 'ready')
        throw new Error('Diagnostic artifact binding mismatch');
      this.insertArtifact(artifact);
      this.store.orm
        .update(simulationAttempts)
        .set({ replayId: artifact.id })
        .where(eq(simulationAttempts.id, attempt.id))
        .run();
      return true;
    });
  }
}
