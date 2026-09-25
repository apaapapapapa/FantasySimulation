import { stagedWork } from './staged-work.ts';
import { canCancelJob } from './job-transitions.ts';
import { ARTIFACT_RESERVATION_BYTES } from '@fantasy/domain/spatial';
import { randomUUID } from 'node:crypto';
import {
  BudgetSchema,
  DEFAULT_BUDGET,
  SpecInputSchema,
  StreamRecordSchema,
  ResultSchema,
  canonicalJson,
  parseJson,
  type Budget,
  type SpecInput,
  type StreamRecord,
} from '@fantasy/domain/spatial';
import { prepareBattle } from '@fantasy/engine/spatial/execution';
import { JobStore, JOB_LIMITS, type Claim, type Job } from './job-store.ts';
import { Store, StoreError, jsonValue } from './store.ts';
import { sha256 } from './replay-files.ts';
import { ReplayWriter } from './replay-writer.ts';
import { BattlePool } from './worker-pool.ts';
import { ownRuntime } from './runtime-owner.ts';
import { ArtifactStore } from './artifact-store.ts';

export type BattleSubmission = {
  key: string;
  spec: SpecInput;
  budget?: Budget;
  simulationHash?: string;
};
export type RuntimeOptions = {
  workers?: number;
  timeoutMs?: number;
  maxRssBytes?: number;
  queueLimit?: number;
  storageBytes?: number;
};
export class BattleService {
  private readonly artifacts: ArtifactStore;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly waiters = new Set<() => void>();
  private generation = 0;
  private stopped = false;
  private failure: Error | null = null;
  private constructor(
    private readonly store: Store,
    private readonly jobs: JobStore,
    private readonly pool: BattlePool,
    private readonly owner: Awaited<ReturnType<typeof ownRuntime>>,
    private readonly options: Required<RuntimeOptions>,
  ) {
    this.artifacts = new ArtifactStore(jobs, owner.root);
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref();
    this.tick();
  }
  static async open(store: Store, root: string, options: RuntimeOptions = {}) {
    const config = {
      workers: 1,
      timeoutMs: JOB_LIMITS.timeoutMs,
      maxRssBytes: 1.5 * 1024 ** 3,
      queueLimit: JOB_LIMITS.queued,
      storageBytes: JOB_LIMITS.storageBytes,
      ...options,
    };
    for (const [name, value, max] of [
      ['timeout', config.timeoutMs, JOB_LIMITS.timeoutMs],
      ['rss', config.maxRssBytes, 1.5 * 1024 ** 3],
      ['queue', config.queueLimit, JOB_LIMITS.queued],
      ['storage', config.storageBytes, JOB_LIMITS.storageBytes],
    ] as const)
      if (!Number.isSafeInteger(value) || value <= 0 || value > max)
        throw new Error(`Invalid ${name} limit`);
    // Leave physical headroom for every active writer, including cancelled diagnostics not yet committed.
    const storageBytes = config.storageBytes - config.workers * ARTIFACT_RESERVATION_BYTES;
    if (storageBytes < ARTIFACT_RESERVATION_BYTES)
      throw new Error('Storage limit cannot fit worker reservations');
    const jobs = new JobStore(store, { ...JOB_LIMITS, queued: config.queueLimit, storageBytes });
    const owner = await ownRuntime(jobs, root);
    try {
      return new BattleService(store, jobs, new BattlePool(config.workers), owner, config);
    } catch (error) {
      owner.release();
      throw error;
    }
  }
  async submit(
    input: SpecInput,
    clientId: string,
    key: string,
    inputBudget: Budget = DEFAULT_BUDGET,
    expectedSimulationHash?: string,
  ) {
    if (this.stopped || this.failure)
      throw new StoreError('unavailable', this.failure?.message ?? 'Runtime closed');
    const spec = parseJson(SpecInputSchema, input),
      budget = parseJson(BudgetSchema, inputBudget);
    const requestHash = sha256(canonicalJson({ spec, budget }));
    const previous = this.jobs.request(clientId, key);
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new StoreError('conflict', 'Idempotency key belongs to another request');
      if (expectedSimulationHash && previous.simulationHash !== expectedSimulationHash)
        throw new StoreError('invalid-input', 'Runtime changed the planned simulation');
      return this.view(previous);
    }
    const battle = await this.store.prepareSpec(spec);
    if (expectedSimulationHash && battle.simulationHash !== expectedSimulationHash)
      throw new StoreError('invalid-input', 'Runtime changed the planned simulation');
    const canonical =
      this.jobs.canonical(battle.simulationHash) ??
      this.jobs.canonicalRecord(battle.simulationHash);
    if (canonical) await this.artifacts.verified(canonical.replayId);
    const job = this.store.transaction(() => {
      this.store.saveSpec(battle);
      return this.jobs.submit({
        simulationHash: battle.simulationHash,
        clientId,
        key,
        requestHash,
        budget,
        ...(canonical ? { cachedResult: canonical } : {}),
      });
    });
    this.tick();
    return this.view(job);
  }
  // A page or an unbounded lazy league source uses the same bounded admission path.
  runMany(
    inputs: AsyncIterable<BattleSubmission> | Iterable<BattleSubmission>,
    clientId: string,
    options: { retryFailed?: boolean; signal?: AbortSignal } = {},
  ) {
    return stagedWork(
      inputs,
      this.pool.workers,
      async (input, signal) => {
        try {
          let job;
          for (;;) {
            signal.throwIfAborted();
            const generation = this.generation;
            try {
              job = await this.submit(
                input.spec,
                clientId,
                input.key,
                input.budget,
                input.simulationHash,
              );
              if (
                options.retryFailed &&
                ['failed', 'cancelled'].includes(job.state) &&
                job.allowedOperations.retry
              )
                job = await this.retry(job.id, job.attempts, input.budget ?? DEFAULT_BUDGET);
              break;
            } catch (error) {
              if (!(error instanceof StoreError) || error.code !== 'queue-capacity') throw error;
              await this.capacityChanged(generation, signal);
            }
          }
          const cancel = () => {
            this.cancel(job.id);
          };
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) cancel();
          try {
            return { key: input.key, job: this.view(await this.wait(job.id)), error: null };
          } catch (error) {
            this.cancel(job.id);
            await this.wait(job.id, this.completionReserveMs);
            throw error;
          } finally {
            signal.removeEventListener('abort', cancel);
          }
        } catch (error) {
          return { key: input.key, job: null, error };
        }
      },
      options.signal,
    );
  }
  private capacityChanged(generation: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        this.waiters.delete(check);
        signal.removeEventListener('abort', check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (signal.aborted) finish(signal.reason ?? new Error('Cancelled'));
        else if (this.stopped || this.failure)
          finish(new StoreError('unavailable', 'Runtime unavailable'));
        else if (generation !== this.generation) finish();
      };
      this.waiters.add(check);
      signal.addEventListener('abort', check, { once: true });
      check();
    });
  }
  async recoverReplay(resultId: string, clientId: string, key: string, inputBudget: Budget) {
    if (this.stopped || this.failure) throw new StoreError('unavailable', 'Runtime unavailable');
    const budget = parseJson(BudgetSchema, inputBudget),
      requestHash = sha256(canonicalJson({ recoverReplay: resultId, budget }));
    const prior = this.jobs.request(clientId, key);
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new StoreError('conflict', 'Idempotency key belongs to another request');
      return this.view(prior);
    }
    const result = this.jobs.result(resultId);
    if (!result) throw new StoreError('not-found', 'Result not found');
    const authority = this.jobs.canonicalRecord(result.simulationHash),
      artifact = this.jobs.artifact(result.replayId);
    if (
      !authority ||
      authority.resultHash !== result.resultHash ||
      !artifact ||
      !['missing', 'corrupt'].includes(artifact.state) ||
      this.jobs.artifact(authority.replayId)?.state === 'quarantined'
    )
      throw new StoreError('conflict', 'Only a missing/corrupt definitive replay can be recovered');
    try {
      const spec = this.store.requireExecutableSpec(result.simulationHash);
      await prepareBattle(spec.manifest);
    } catch {
      throw new StoreError('conflict', 'Saved engine identity is unsupported; replay remains held');
    }
    const job = this.jobs.submit({
      simulationHash: result.simulationHash,
      clientId,
      key,
      requestHash,
      budget,
    });
    this.tick();
    return this.view(job);
  }
  private changed() {
    this.generation++;
    for (const listener of [...this.waiters]) listener();
  }
  private tick() {
    if (this.stopped || this.failure) return;
    try {
      if (this.jobs.recover()) this.changed();
      if (process.memoryUsage.rss() > this.options.maxRssBytes) {
        this.failure = new Error('Process RSS safety limit exceeded');
        for (const task of this.active.values()) task.controller.abort(this.failure);
        this.changed();
        return;
      }
      while (this.active.size < this.pool.workers) {
        const claim = this.jobs.claim(Date.now(), JOB_LIMITS.leaseMs, [...this.active.keys()]);
        if (!claim) break;
        const controller = new AbortController();
        const done = this.execute(claim, controller)
          .catch((error: unknown) => {
            // Unexpected persistence failures stop admission instead of becoming unhandled rejections.
            this.failure = error instanceof Error ? error : new Error(String(error));
          })
          .finally(() => {
            this.active.delete(claim.job.id);
            this.changed();
            this.tick();
          });
        this.active.set(claim.job.id, { controller, done });
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.changed();
    }
  }
  private async execute(claim: Claim, controller: AbortController) {
    const id = randomUUID(),
      resultId = randomUUID();
    let writer: ReplayWriter | undefined,
      terminal = false,
      step = 0;
    let pendingTerminal: Extract<StreamRecord, { kind: 'terminal' }> | undefined;
    const started = performance.now();
    const timeout = setTimeout(() => {
      const error = new Error('Worker wall-clock timeout');
      try {
        this.jobs.fail(claim, error.message);
      } catch (failure) {
        this.failure = failure instanceof Error ? failure : new Error(String(failure));
      }
      controller.abort(error);
    }, this.options.timeoutMs);
    const heartbeat = setInterval(
      () => {
        try {
          if (!this.jobs.heartbeat(claim)) controller.abort(new Error('Attempt ownership lost'));
          else this.jobs.progress(claim, step);
        } catch (error) {
          controller.abort(error);
        }
      },
      Math.floor(JOB_LIMITS.leaseMs / 3),
    );
    try {
      const spec = this.store.requireExecutableSpec(claim.job.simulationHash);
      writer = await ReplayWriter.create(this.owner.root, {
        id,
        attemptId: claim.attempt.id,
        simulationHash: spec.simulationHash,
        input: spec.manifest,
      });
      const output = await this.pool.run(
        spec.manifest,
        parseJson(BudgetSchema, jsonValue(claim.attempt.budgetJson)),
        async (records) => {
          for (const input of records) {
            const record = parseJson(StreamRecordSchema, input);
            if (record.kind === 'terminal') {
              pendingTerminal = record;
              continue;
            }
            await writer!.append(record);
            step = record.kind === 'interval' ? record.toStep : record.step;
          }
        },
        controller.signal,
      );
      if (controller.signal.aborted) throw controller.signal.reason;
      const result = parseJson(ResultSchema, output.result);
      if (!pendingTerminal) throw new Error('Worker did not supply a terminal record');
      await writer.append(pendingTerminal);
      terminal = true;
      const manifest = await writer.finish({ kind: 'result', result }, resultId);
      if (controller.signal.aborted) throw controller.signal.reason;
      const committed = this.jobs.complete(
        claim,
        resultId,
        result,
        this.artifacts.metadata(manifest),
      );
      if (!committed.accepted) await this.artifacts.discard(id);
      this.jobs.progress(claim, step, { ...output.metrics, totalMs: performance.now() - started });
    } catch (error) {
      const reason = (
        controller.signal.aborted
          ? String(controller.signal.reason)
          : error instanceof Error
            ? error.message
            : String(error)
      ).slice(0, 1000);
      this.jobs.fail(claim, reason);
      if (writer) {
        try {
          // A terminal record cannot be relabelled as a partial diagnostic.
          if (terminal) await writer.discard();
          else {
            const cancelled = this.jobs.get(claim.job.id)?.state === 'cancelled';
            const manifest = await writer.finish(
              { kind: cancelled ? 'cancelled' : 'failed', reason: reason.slice(0, 500) },
              null,
            );
            if (!this.jobs.saveDiagnostic(claim, this.artifacts.metadata(manifest)))
              await this.artifacts.discard(id);
          }
        } catch {
          await writer.discard();
        }
      }
      await this.artifacts.discard(id);
      this.jobs.progress(claim, step, { totalMs: performance.now() - started, failure: reason });
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
    }
  }
  cancel(id: string) {
    const job = this.jobs.cancel(id);
    if (job.state === 'cancelled')
      this.active.get(id)?.controller.abort(new Error('Cancelled by client'));
    this.changed();
    return this.view(job);
  }
  async retry(id: string, expectedAttempts: number, budget: Budget) {
    if (this.stopped || this.failure) throw new StoreError('unavailable', 'Runtime unavailable');
    const previous = this.active.get(id);
    if (previous) {
      if (!previous.controller.signal.aborted)
        throw new StoreError('conflict', 'Previous attempt is still running');
      // Cancellation is visible before the Worker/writer have released their resources.
      // Accept a single user retry after cleanup, then revalidate the optimistic attempt
      // count in the store. Concurrent requests cannot enqueue two attempts.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          previous.done,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(new StoreError('conflict', 'Previous attempt is still releasing resources')),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
    if (this.stopped || this.failure) throw new StoreError('unavailable', 'Runtime unavailable');
    const job = this.jobs.retry(id, expectedAttempts, budget);
    this.tick();
    return this.view(job);
  }
  wait(id: string, timeoutMs = 60_000): Promise<Job> {
    return new Promise((resolve, reject) => {
      const finish = (outcome: { job: Job } | { error: unknown }) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        if ('error' in outcome) reject(outcome.error);
        else resolve(outcome.job);
      };
      const check = () => {
        try {
          const job = this.jobs.get(id);
          if (!job) throw new StoreError('not-found', 'Job not found');
          if (!['queued', 'running'].includes(job.state) && !this.active.has(id))
            return finish({ job });
          if (this.failure) throw this.failure;
          if (this.stopped && !this.active.has(id))
            throw new StoreError('unavailable', 'Runtime closed');
        } catch (error) {
          finish({ error });
        }
      };
      const timer = setTimeout(() => finish({ error: new Error('Job wait timeout') }), timeoutMs);
      // Subscribe before reading so completion cannot be lost between the two operations.
      this.waiters.add(check);
      check();
    });
  }
  get completionReserveMs() {
    return this.options.timeoutMs + 1000;
  }
  private view(job: Job) {
    let retry = false;
    try {
      if (this.jobs.retryable(job)) {
        this.store.requireExecutableSpec(job.simulationHash);
        retry = true;
      }
    } catch {
      /* Invalid/unavailable saved inputs do not grant an operation. */
    }
    return { ...job, allowedOperations: { cancel: canCancelJob(job), retry } };
  }
  status(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new StoreError('not-found', 'Job not found');
    const attempts = this.jobs.attempts(id).map((attempt) => {
      const { token: _, budgetJson, ...publicAttempt } = attempt;
      const metrics = this.jobs.metrics(attempt.id);
      return {
        ...publicAttempt,
        budget: jsonValue(budgetJson),
        progressStep: metrics?.progressStep ?? 0,
        metrics: metrics?.metricsJson ? jsonValue(metrics.metricsJson) : null,
      };
    });
    return { job: this.view(job), attempts };
  }
  async resultSnapshot(id: string) {
    const row = this.jobs.result(id);
    if (!row) throw new StoreError('not-found', 'Result not found');
    const manifest = await this.artifacts.verified(row.replayId);
    if (
      manifest.resultId !== row.id ||
      manifest.end.kind !== 'result' ||
      sha256(canonicalJson(manifest.end.result)) !== row.resultHash ||
      canonicalJson(manifest.end.result) !== row.resultJson
    )
      throw new StoreError('unavailable', 'Result/replay binding mismatch');
    return {
      response: {
        id: row.id,
        result: parseJson(ResultSchema, jsonValue(row.resultJson)),
        replayId: row.replayId,
      },
      manifest,
      bytes: this.artifacts.metadata(manifest).bytes,
      resultHash: row.resultHash,
    };
  }
  async result(id: string) {
    return (await this.resultSnapshot(id)).response;
  }
  replay(id: string) {
    return this.artifacts.verified(id);
  }
  replayFile(id: string, file: string) {
    return this.artifacts.file(id, file);
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    this.changed();
    clearInterval(this.timer);
    for (const task of this.active.values())
      task.controller.abort(new Error('Coordinator shutdown'));
    await Promise.all([...this.active.values()].map((t) => t.done));
    try {
      await this.pool.close();
    } finally {
      this.owner.release();
    }
  }
}
