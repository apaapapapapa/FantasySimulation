import { currentMeasurements, measureAsync, measureSync, sampleDatabase } from '../measurements.ts';
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
import { type BattleSubmission, BattleService } from '../jobs/battle-service.ts';
import { stagedWork } from '../jobs/staged-work.ts';
import { BattleBundles } from './battle-bundle.ts';
import { validateBatchPlan } from './batch-plan.ts';
import { shardSlots } from './batch-check.ts';
import { openStore } from '../db/store.ts';

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
  // One replay is bounded to 20 MiB. Reserve before pulling: at most two/40 MiB,
  // with the original one-item window retained when work capacity is tight.
  const publicationWindow = Math.min(
    2,
    Math.floor((64 * 1024 ** 2) / ARTIFACT_RESERVATION_BYTES),
    Math.floor(plan.maxWorkBytes / ARTIFACT_RESERVATION_BYTES) - workers * 2,
  );
  const selected = shardSlots(plan, shardIndex, shardCount);
  const slots = options.reverse ? [...selected].reverse() : selected;
  const estimated = slots.length * plan.estimatedBytesPerMatch;
  if (estimated > plan.maxOutputBytes) throw new Error('Shard estimate exceeds output budget');
  await mkdir(join(root, '.work'), { recursive: true });
  const databasePath = join(root, '.work', 'database.sqlite');
  const store = measureSync('db.open', () => openStore(databasePath));
  let runtime: BattleService | undefined;
  const started = performance.now(),
    results: BatchIndex['slots'] = [];
  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  try {
    // Bound SQLite separately from compressed artifacts; WAL is checkpointed after each slot.
    const pageSize = Number(store.db.pragma('page_size', { simple: true }));
    const pages = Math.floor((64 * 1024 ** 2) / pageSize);
    if (Number(store.db.pragma(`max_page_count = ${pages}`, { simple: true })) > pages)
      throw new Error('Batch database exceeds the 64 MiB metadata limit');
    await store.loadPinnedRevisions(plan.revisions);
    runtime = await measureAsync('worker.poolOpen', () =>
      BattleService.open(store, join(root, '.work', 'replays'), {
        workers,
        storageBytes: plan.maxWorkBytes,
      }),
    );
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
            signal.aborted ||
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
    let publication = Promise.resolve(),
      queued = 0;
    const publications = stagedWork(
      runtime.runMany(pending, `batch:${plan.id.slice(7)}`, { ...options, signal }),
      publicationWindow,
      async (outcome) => {
        const previous = publication,
          queuedAt = performance.now(),
          position = ++queued,
          measurement = currentMeasurements();
        let release!: () => void;
        publication = new Promise<void>((resolve) => {
          release = resolve;
        });
        measurement?.capacity('save.queueReservedBytes', queued * ARTIFACT_RESERVATION_BYTES);
        try {
          // Pulling the next result overlaps computation with saving. Capacity checks,
          // object/pointer commits and WAL checkpoints still have one ordered writer.
          await previous;
          measurement?.queue('save.publication', performance.now() - queuedAt, position);
          const entry = entries.get(outcome.key)!;
          try {
            if (outcome.error) throw outcome.error;
            const done = outcome.job!;
            if (!done.resultId || done.state !== 'completed') {
              entry.state = 'failed';
              entry.reason = done.error ?? done.state;
            } else {
              try {
                entry.receipt = await measureAsync('save.publish', () =>
                  bundles.publish(runtime!, done.resultId!, source),
                );
              } catch (error) {
                stop.abort(error);
                throw error;
              }
              const kind = entry.receipt.result.outcome.kind;
              entry.state = kind === 'win' || kind === 'draw' ? 'complete' : kind;
              entry.reason =
                entry.state === 'complete'
                  ? ''
                  : canonicalJson(entry.receipt.result).slice(0, 1000);
            }
          } catch (error) {
            entry.state = 'failed';
            entry.reason = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
          }
          sampleDatabase(databasePath);
          measureSync('db.walCheckpoint', () => store.db.pragma('wal_checkpoint(TRUNCATE)'));
          sampleDatabase(databasePath);
        } catch (error) {
          stop.abort(error);
          throw error;
        } finally {
          queued--;
          release();
        }
      },
    );
    // Do not abort this consumer: runMany stops admission and every admitted save drains.
    for await (const _ of publications) {
      /* The index is issued only after all publications have settled. */
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
