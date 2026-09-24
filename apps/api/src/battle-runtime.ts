import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
import { JobStore, JOB_LIMITS, type Claim } from './job-store.ts';
import { Store, StoreError, jsonValue } from './store.ts';
import { sha256 } from './replay-files.ts';
import { ReplayWriter } from './replay-writer.ts';
import { BattlePool } from './worker-pool.ts';
import { ownRuntime } from './runtime-owner.ts';
import { ArtifactStore } from './artifact-store.ts';

export type RuntimeOptions = {
  workers?: number;
  timeoutMs?: number;
  maxRssBytes?: number;
  queueLimit?: number;
  storageBytes?: number;
};
export class BattleRuntime {
  readonly artifacts: ArtifactStore;
  readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;
  private failure: Error | null = null;
  private constructor(
    readonly jobs: JobStore,
    readonly pool: BattlePool,
    readonly owner: Awaited<ReturnType<typeof ownRuntime>>,
    readonly options: Required<RuntimeOptions>,
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
    const storageBytes = config.storageBytes - config.workers * 20 * 1024 ** 2;
    if (storageBytes < 20 * 1024 ** 2)
      throw new Error('Storage limit cannot fit worker reservations');
    const jobs = new JobStore(store, { ...JOB_LIMITS, queued: config.queueLimit, storageBytes });
    const owner = await ownRuntime(jobs, root);
    try {
      return new BattleRuntime(jobs, new BattlePool(config.workers), owner, config);
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
  ) {
    if (this.stopped || this.failure)
      throw new StoreError(503, this.failure?.message ?? 'Runtime closed');
    const spec = parseJson(SpecInputSchema, input),
      budget = parseJson(BudgetSchema, inputBudget);
    const requestHash = sha256(canonicalJson({ spec, budget }));
    const previous = this.jobs.request(clientId, key);
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new StoreError(409, 'Idempotency key belongs to another request');
      return previous;
    }
    const battle = await this.jobs.store.prepareSpec(spec);
    const canonical =
      this.jobs.canonical(battle.simulationHash) ??
      this.jobs.canonicalRecord(battle.simulationHash);
    if (canonical) await this.artifacts.verified(canonical.replayId);
    const job = this.jobs.store.transaction(() => {
      this.jobs.store.saveSpec(battle);
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
    return job;
  }
  async recoverReplay(resultId: string, clientId: string, key: string, inputBudget: Budget) {
    if (this.stopped || this.failure) throw new StoreError(503, 'Runtime unavailable');
    const budget = parseJson(BudgetSchema, inputBudget),
      requestHash = sha256(canonicalJson({ recoverReplay: resultId, budget }));
    const prior = this.jobs.request(clientId, key);
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new StoreError(409, 'Idempotency key belongs to another request');
      return prior;
    }
    const result = this.jobs.result(resultId);
    if (!result) throw new StoreError(404, 'Result not found');
    const authority = this.jobs.canonicalRecord(result.simulationHash),
      artifact = this.jobs.artifact(result.replayId);
    if (
      !authority ||
      authority.resultHash !== result.resultHash ||
      !artifact ||
      !['missing', 'corrupt'].includes(artifact.state) ||
      this.jobs.artifact(authority.replayId)?.state === 'quarantined'
    )
      throw new StoreError(409, 'Only a missing/corrupt definitive replay can be recovered');
    try {
      const spec = this.jobs.store.requireExecutableSpec(result.simulationHash);
      await prepareBattle(spec.manifest);
    } catch {
      throw new StoreError(409, 'Saved engine identity is unsupported; replay remains held');
    }
    const job = this.jobs.submit({
      simulationHash: result.simulationHash,
      clientId,
      key,
      requestHash,
      budget,
    });
    this.tick();
    return job;
  }
  private tick() {
    if (this.stopped || this.failure) return;
    try {
      this.jobs.recover();
      if (process.memoryUsage.rss() > this.options.maxRssBytes) {
        this.failure = new Error('Process RSS safety limit exceeded');
        for (const task of this.active.values()) task.controller.abort(this.failure);
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
            this.tick();
          });
        this.active.set(claim.job.id, { controller, done });
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
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
      const spec = this.jobs.store.requireExecutableSpec(claim.job.simulationHash);
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
    return job;
  }
  async retry(id: string, expectedAttempts: number, budget: Budget) {
    if (this.stopped || this.failure) throw new StoreError(503, 'Runtime unavailable');
    const previous = this.active.get(id);
    if (previous) {
      if (!previous.controller.signal.aborted)
        throw new StoreError(409, 'Previous attempt is still running');
      // Cancellation is visible before the Worker/writer have released their resources.
      // Accept a single user retry after cleanup, then revalidate the optimistic attempt
      // count in the store. Concurrent requests cannot enqueue two attempts.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          previous.done,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new StoreError(409, 'Previous attempt is still releasing resources')),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
    if (this.stopped || this.failure) throw new StoreError(503, 'Runtime unavailable');
    const job = this.jobs.retry(id, expectedAttempts, budget);
    this.tick();
    return job;
  }
  async wait(id: string, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = this.jobs.get(id);
      if (!job) throw new StoreError(404, 'Job not found');
      if (!['queued', 'running'].includes(job.state) && !this.active.has(id)) return job;
      if (this.failure) throw this.failure;
      if (Date.now() >= deadline) throw new Error('Job wait timeout');
      await delay(10);
    }
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
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
