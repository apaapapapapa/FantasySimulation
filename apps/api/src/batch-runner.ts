import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BatchIndexBodySchema,
  compareIds,
  contentHash,
  parseJson,
  type BatchIndex,
  type ExecutionSource,
} from '@fantasy/domain/spatial';
import { BattleRuntime } from './battle-runtime.ts';
import { BattleBundles } from './battle-bundle.ts';
import { validateBatchPlan } from './batch-plan.ts';
import { shardSlots } from './batch-check.ts';
import { openStore, jsonValue } from './store.ts';

export async function runBatch(
  input: unknown,
  root: string,
  source: ExecutionSource,
  options: {
    workers?: number;
    shardIndex?: number;
    shardCount?: number;
    deadlineMs?: number;
    reverse?: boolean;
    retryFailed?: boolean;
    signal?: AbortSignal;
  } = {},
) {
  const plan = await validateBatchPlan(input, source),
    workers = options.workers ?? 1;
  const shardIndex = options.shardIndex ?? 0,
    shardCount = options.shardCount ?? 1;
  const deadlineMs = options.deadlineMs ?? 1_800_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 1_800_000)
    throw new Error('Invalid batch deadline');
  if (plan.maxWorkBytes < (workers * 2 + 1) * 20 * 1024 ** 2)
    throw new Error('Work capacity cannot fit concurrent Worker reservations; use fewer Workers');
  const selected = shardSlots(plan, shardIndex, shardCount);
  const slots = options.reverse ? [...selected].reverse() : selected;
  const estimated = slots.length * plan.estimatedBytesPerMatch;
  if (estimated > plan.maxOutputBytes) throw new Error('Shard estimate exceeds output budget');
  await mkdir(join(root, '.work'), { recursive: true });
  const store = openStore(join(root, '.work', 'database.sqlite'));
  let runtime: BattleRuntime | undefined;
  const started = performance.now(),
    results: BatchIndex['slots'] = [];
  try {
    // Bound SQLite separately from compressed artifacts; WAL is checkpointed after each slot.
    const pageSize = Number(store.db.pragma('page_size', { simple: true }));
    const pages = Math.floor((64 * 1024 ** 2) / pageSize);
    if (Number(store.db.pragma(`max_page_count = ${pages}`, { simple: true })) > pages)
      throw new Error('Batch database exceeds the 64 MiB metadata limit');
    await store.loadPinnedRevisions(plan.revisions);
    runtime = await BattleRuntime.open(store, join(root, '.work', 'replays'), {
      workers,
      storageBytes: plan.maxWorkBytes,
    });
    const bundles = new BattleBundles(root, plan.maxOutputBytes);
    await bundles.recoverStaging();
    await bundles.publishJson('plans', plan.id, plan);
    let cursor = 0,
      publication = Promise.resolve();
    async function next() {
      while (cursor < slots.length) {
        const slot = slots[cursor++]!;
        const entry: BatchIndex['slots'][number] = {
          slotId: slot.id,
          simulationHash: slot.simulationHash,
          state: 'pending',
          receipt: null,
          reused: false,
          reason: '',
        };
        try {
          const existing = await bundles.cached(slot.simulationHash);
          if (existing) {
            entry.receipt = existing;
            entry.state = 'complete';
            entry.reused = true;
          } else if (
            options.signal?.aborted ||
            performance.now() - started + runtime!.options.timeoutMs + 1000 >= deadlineMs
          )
            entry.reason = 'Batch stopped or deadline reserve reached; no new match was started';
          else {
            let job = await runtime!.submit(
              slot.spec,
              `batch:${plan.id.slice(7)}`,
              slot.id,
              plan.budget,
            );
            if (job.simulationHash !== slot.simulationHash)
              throw new Error('Runtime changed the planned simulation');
            if (
              options.retryFailed &&
              ['failed', 'cancelled'].includes(job.state) &&
              job.attempts < job.maxAttempts
            )
              job = await runtime!.retry(job.id, job.attempts, plan.budget);
            const cancel = () => runtime!.cancel(job.id);
            options.signal?.addEventListener('abort', cancel, { once: true });
            if (options.signal?.aborted) cancel();
            let done;
            try {
              done = await runtime!.wait(job.id);
            } finally {
              options.signal?.removeEventListener('abort', cancel);
            }
            if (!done.resultId || done.state !== 'completed') {
              entry.state = 'failed';
              entry.reason = done.error ?? done.state;
            } else {
              const result = runtime!.jobs.result(done.resultId)!;
              // Only one publisher uses this output directory; independent shards use independent roots.
              const saving = publication.then(async () => {
                entry.receipt = await bundles.publish(runtime!, result, source);
              });
              publication = saving.catch(() => {});
              await saving;
              const kind = entry.receipt!.result.outcome.kind;
              entry.state = kind === 'win' || kind === 'draw' ? 'complete' : kind;
              entry.reason =
                entry.state === 'complete' ? '' : JSON.stringify(jsonValue(result.resultJson));
              entry.reason = entry.reason.slice(0, 1000);
            }
          }
        } catch (error) {
          entry.state = 'failed';
          entry.reason = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
        }
        results.push(entry);
        store.db.pragma('wal_checkpoint(TRUNCATE)');
      }
    }
    await Promise.all(Array.from({ length: workers }, () => next()));
    const body = parseJson(BatchIndexBodySchema, {
      schemaVersion: 1,
      source,
      planId: plan.id,
      shardIndex,
      shardCount,
      slots: results.sort((a, b) => compareIds(a.slotId, b.slotId)),
      complete: results.every((r) => r.state === 'complete'),
    });
    const index: BatchIndex = { ...body, id: await contentHash(body) };
    const path = await bundles.publishJson('indexes', index.id, index);
    return { index, path, elapsedMs: performance.now() - started };
  } finally {
    await runtime?.close();
    store.close();
  }
}

export { reconcileBatch } from './batch-check.ts';
