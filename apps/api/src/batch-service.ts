import { ARTIFACT_RESERVATION_BYTES } from '@fantasy/domain/spatial';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BatchIndexBodySchema,
  compareIds,
  contentHash,
  canonicalJson,
  parseJson,
  type BatchIndex,
  type ExecutionSource,
} from '@fantasy/domain/spatial';
import { type BattleSubmission, BattleService } from './battle-service.ts';
import { BattleBundles } from './battle-bundle.ts';
import { validateBatchPlan } from './batch-plan.ts';
import { shardSlots } from './batch-check.ts';
import { openStore } from './store.ts';

export async function executeBatch(
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
  if (plan.maxWorkBytes < (workers * 2 + 1) * ARTIFACT_RESERVATION_BYTES)
    throw new Error('Work capacity cannot fit concurrent Worker reservations; use fewer Workers');
  const selected = shardSlots(plan, shardIndex, shardCount);
  const slots = options.reverse ? [...selected].reverse() : selected;
  const estimated = slots.length * plan.estimatedBytesPerMatch;
  if (estimated > plan.maxOutputBytes) throw new Error('Shard estimate exceeds output budget');
  await mkdir(join(root, '.work'), { recursive: true });
  const store = openStore(join(root, '.work', 'database.sqlite'));
  let runtime: BattleService | undefined;
  const started = performance.now(),
    results: BatchIndex['slots'] = [];
  try {
    // Bound SQLite separately from compressed artifacts; WAL is checkpointed after each slot.
    const pageSize = Number(store.db.pragma('page_size', { simple: true }));
    const pages = Math.floor((64 * 1024 ** 2) / pageSize);
    if (Number(store.db.pragma(`max_page_count = ${pages}`, { simple: true })) > pages)
      throw new Error('Batch database exceeds the 64 MiB metadata limit');
    await store.loadPinnedRevisions(plan.revisions);
    runtime = await BattleService.open(store, join(root, '.work', 'replays'), {
      workers,
      storageBytes: plan.maxWorkBytes,
    });
    const bundles = new BattleBundles(root, plan.maxOutputBytes);
    await bundles.recoverStaging();
    await bundles.publishJson('plans', plan.id, plan);
    const entries = new Map<string, BatchIndex['slots'][number]>();
    async function* submissions(): AsyncGenerator<BattleSubmission> {
      for (const slot of slots) {
        if (entries.has(slot.id)) continue;
        const entry: BatchIndex['slots'][number] = {
          slotId: slot.id,
          simulationHash: slot.simulationHash,
          state: 'pending',
          receipt: null,
          reused: false,
          reason: '',
        };
        entries.set(slot.id, entry);
        results.push(entry);
        try {
          const existing = await bundles.cached(slot.simulationHash);
          if (existing) {
            entry.receipt = existing;
            entry.state = 'complete';
            entry.reused = true;
          } else if (
            options.signal?.aborted ||
            performance.now() - started + runtime!.completionReserveMs >= deadlineMs
          ) {
            entry.reason = 'Batch stopped or deadline reserve reached; no new match was started';
          } else {
            yield {
              key: slot.id,
              spec: slot.spec,
              budget: plan.budget,
              simulationHash: slot.simulationHash,
            };
          }
        } catch (error) {
          entry.state = 'failed';
          entry.reason = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
        }
      }
    }
    // Keep pending rows even on abort. Only the service's in-flight jobs receive cancellation.
    const pending = submissions();
    for await (const outcome of runtime.runMany(pending, `batch:${plan.id.slice(7)}`, options)) {
      const entry = entries.get(outcome.key)!;
      try {
        if (outcome.error) throw outcome.error;
        const done = outcome.job!;
        if (!done.resultId || done.state !== 'completed') {
          entry.state = 'failed';
          entry.reason = done.error ?? done.state;
        } else {
          // Consumer backpressure serializes publication while Workers remain bounded.
          entry.receipt = await bundles.publish(runtime, done.resultId, source);
          const kind = entry.receipt.result.outcome.kind;
          entry.state = kind === 'win' || kind === 'draw' ? 'complete' : kind;
          entry.reason =
            entry.state === 'complete' ? '' : canonicalJson(entry.receipt.result).slice(0, 1000);
        }
      } catch (error) {
        entry.state = 'failed';
        entry.reason = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      }
      store.db.pragma('wal_checkpoint(TRUNCATE)');
    }
    // Preserve cached/held rows even when admission was stopped before the first pull.
    // The generator marks the remaining noncached slots pending without submitting them.
    for await (const _ of submissions()) throw new Error('Staging left unsubmitted work');
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
export { createBatchPlan, validateBatchPlan, executionSource } from './batch-plan.ts';
