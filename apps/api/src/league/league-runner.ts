import { OperationError } from '../operation-error.ts';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  BatchIndexBodySchema,
  canonicalJson,
  contentHash,
  IdSchema,
  parseJson,
  LeagueReservationBodySchema,
  LeaguePartitionResultBodySchema,
  type BatchPlan,
  type BatchIndex,
  type LeaguePlan,
  type LeaguePartition,
  type LeagueProgress,
  type LeagueReservation,
  type LeaguePartitionResult,
  type ExecutionSource,
} from '@fantasy/domain/spatial';
import { createBatchPlan } from '../batch/batch-plan.ts';
import { runBatch } from '../batch/batch-runner.ts';
import { BattlePool } from '../jobs/worker-pool.ts';
import { BattleBundles, type BundleRead } from '../batch/battle-bundle.ts';
import { checkedBatch } from '../batch/batch-check.ts';
import { publishImmutableFile } from '../replay/replay-files.ts';
import { validateLeaguePlan, validateLeaguePartition } from './league-plan.ts';
import {
  nextLeagueAttempt,
  progressPage,
  validateLeagueReservation,
  verifyLeagueProgress,
} from './league-progress.ts';

export async function reserveLeaguePartition(
  plan: LeaguePlan,
  partition: LeaguePartition,
  input: readonly LeagueProgress[],
  executionId: string,
  retained?: BundleRead,
): Promise<LeagueReservation> {
  IdSchema.parse(executionId);
  const prior = await verifyLeagueProgress(input, retained);
  const records = partition.slots.map((slot) => {
    const record = prior.get(slot.simulationHash) ?? {
      simulationHash: slot.simulationHash,
      attempts: [],
    };
    if (record.attempts.some((a) => a.executionId === executionId))
      throw new OperationError(
        'IDENTITY_MISMATCH',
        'Execution ID was already reserved; use a new execution and retain its history',
      );
    const attempt = nextLeagueAttempt(record);
    if (attempt)
      record.attempts.push({ attempt, executionId, state: 'reserved', objectHash: null });
    return record;
  });
  const body = parseJson(LeagueReservationBodySchema, {
    schemaVersion: 1,
    planId: plan.id,
    partitionId: partition.id,
    executionId,
    progress: await progressPage(records),
  });
  return { ...body, id: await contentHash(body) };
}

async function runSelection(
  batch: BatchPlan,
  plan: LeaguePlan,
  records: Map<string, LeagueProgress>,
  executionId: string,
  attempt: 1 | 2,
  bundles: BattleBundles,
  options: Parameters<typeof runBatch>[3],
) {
  const selected = batch.slots.filter((slot) => {
    const latest = records.get(slot.simulationHash)?.attempts.at(-1);
    return (
      latest?.state === 'reserved' &&
      latest.executionId === executionId &&
      latest.attempt === attempt
    );
  });
  if (!selected.length) return [];
  const retry = await createBatchPlan(
    {
      schemaVersion: 1,
      revisions: batch.revisions,
      matches: selected.map(({ key, spec }) => ({ key, spec })),
      budget:
        attempt === 1 ? plan.revision.definition.budget : plan.revision.definition.retryBudget,
      estimatedBytesPerMatch: batch.estimatedBytesPerMatch,
      maxOutputBytes: batch.maxOutputBytes,
      maxWorkBytes: batch.maxWorkBytes,
    },
    plan.source,
  );
  const result = await runBatch(retry, bundles.root, plan.source, {
    ...options,
    retryFailed: attempt === 2,
  });
  const checked = await checkedBatch(retry, [{ index: result.index, bundles }]);
  return [...checked.found.values()];
}

export async function runLeaguePartition(
  planInput: unknown,
  partitionInput: unknown,
  batchInput: unknown,
  reservationInput: unknown,
  root: string,
  source: ExecutionSource,
  executionId: string,
  options: {
    workers?: number;
    pool?: BattlePool;
    deadlineMs?: number;
    reverse?: boolean;
    signal?: AbortSignal;
    retained?: BattleBundles;
    /** Caller-owned open public scope on `root/bundles`, shared with its producer seal. */
    bundles?: BattleBundles;
  } = {},
): Promise<LeaguePartitionResult> {
  const started = performance.now(),
    plan = await validateLeaguePlan(planInput);
  if (canonicalJson(source) !== canonicalJson(plan.source))
    throw new OperationError('IDENTITY_MISMATCH', 'League execution source mismatch');
  const { partition, batch } = await validateLeaguePartition(plan, partitionInput, batchInput);
  const reservation = await validateLeagueReservation(plan, partition, reservationInput),
    { id } = reservation;
  if (reservation.executionId !== executionId)
    throw new OperationError('IDENTITY_MISMATCH', 'League reservation identity mismatch');
  const deadline = options.deadlineMs ?? 1500000;
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > 1800000)
    throw new OperationError('INPUT_INVALID', 'Invalid league deadline');
  const workers = options.workers ?? options.pool?.workers ?? 1;
  if (options.pool && options.pool.workers !== workers)
    throw new OperationError('INPUT_INVALID', 'League worker count differs from borrowed pool');
  const bundleRoot = join(root, 'bundles');
  if (
    options.bundles &&
    (!options.pool ||
      resolve(options.bundles.root) !== resolve(bundleRoot) ||
      options.bundles.maxBytes !== batch.maxOutputBytes ||
      !options.bundles.isPublicScope(options.pool))
  )
    throw new OperationError('INPUT_INVALID', 'Borrowed producer scope differs from partition');
  // One producer owns the scope; every later check still reopens and hashes saved bytes.
  // Retained inputs get their own scope: one full pass each, then imports re-hash them.
  const pool = options.pool ?? new BattlePool(workers),
    bundles =
      options.bundles ??
      new BattleBundles(bundleRoot, batch.maxOutputBytes).verificationSession({
        publicData: true,
        pool,
      }),
    retained = options.retained?.verificationSession({ pool });
  try {
    const records = await verifyLeagueProgress(reservation.progress.records, retained);
    await mkdir(join(root, 'reservations'), { recursive: true });
    // This create-only claim also blocks concurrent local runners and same-token reruns.
    await publishImmutableFile(
      join(root, 'reservations', id.slice(7) + '.json'),
      canonicalJson(reservation),
    );
    const results = new Map<string, BatchIndex['slots'][number]>();
    if (retained)
      for (const record of records.values())
        for (const attempt of record.attempts)
          if (attempt.objectHash) await bundles.importRecorded(retained, attempt.objectHash);
    for (const slot of batch.slots) {
      const attempts = records.get(slot.simulationHash)!.attempts;
      const latest =
        attempts.at(-1)?.state === 'reserved' && attempts.at(-1)?.executionId === executionId
          ? attempts.at(-2)
          : attempts.at(-1);
      const entry: BatchIndex['slots'][number] = {
        slotId: slot.id,
        simulationHash: slot.simulationHash,
        state: 'pending',
        receipt: null,
        reused: false,
        reason: '',
      };
      if (latest && (latest.state === 'win' || latest.state === 'draw')) {
        if (!retained || !latest.objectHash)
          throw new OperationError('DATA_INVALID', 'Reusable result is unavailable');
        entry.receipt = await bundles.importConfirmed(retained, latest.objectHash);
        entry.state = 'complete';
        entry.reused = true;
      } else if (
        latest?.objectHash &&
        (latest.state === 'truncated' || latest.state === 'unresolved')
      ) {
        entry.receipt = await bundles.verify(latest.objectHash);
        entry.state = latest.state;
        entry.reason = 'Retry budget exhausted; partial replay remains available';
      } else if (latest && latest.state !== 'reserved') {
        entry.state = 'failed';
        entry.reason = 'Retry budget exhausted; result remains unresolved';
      } else if (latest && latest.executionId !== executionId) {
        entry.state = 'failed';
        entry.reason = 'Reserved attempt returned no verified result';
      }
      results.set(slot.id, entry);
    }
    for (const attempt of [1, 2] as const) {
      const outcomes = await runSelection(batch, plan, records, executionId, attempt, bundles, {
        workers,
        pool,
        deadlineMs: Math.max(1, Math.floor(deadline - (performance.now() - started))),
        reverse: options.reverse ?? false,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      for (const entry of outcomes) {
        const record = records.get(entry.simulationHash)!,
          latest = record.attempts.at(-1)!;
        if (
          latest.state !== 'reserved' ||
          latest.executionId !== executionId ||
          latest.attempt !== attempt
        )
          throw new OperationError(
            'IDENTITY_MISMATCH',
            'Returned result has no matching reservation',
          );
        if (entry.state === 'pending') {
          record.attempts.pop(); // Proven not admitted: retain the same available attempt and prior partial replay.
          continue;
        } else {
          latest.state =
            entry.receipt?.result.outcome.kind ??
            (options.signal?.aborted ? 'cancelled' : 'failed');
          latest.objectHash = entry.receipt?.objectHash ?? null;
        }
        results.set(entry.slotId, entry);
      }
    }
    const indexBody = parseJson(BatchIndexBodySchema, {
      schemaVersion: 1,
      source,
      planId: batch.id,
      shardIndex: 0,
      shardCount: 1,
      slots: batch.slots.map((slot) => results.get(slot.id)!),
      complete: [...results.values()].every((entry) => entry.state === 'complete'),
    });
    const index = { ...indexBody, id: await contentHash(indexBody) };
    await checkedBatch(batch, [{ index, bundles }]);
    const body = parseJson(LeaguePartitionResultBodySchema, {
      schemaVersion: 1,
      reservationId: id,
      index,
      progress: await progressPage([...records.values()]),
      elapsedMs: Math.round(performance.now() - started),
    });
    const result = { ...body, id: await contentHash(body) };
    await mkdir(join(root, 'results'), { recursive: true });
    await publishImmutableFile(
      join(root, 'results', result.id.slice(7) + '.json'),
      canonicalJson(result),
    );
    return result;
  } finally {
    retained?.closeVerification();
    if (!options.bundles) bundles.closeVerification();
    if (!options.pool) await pool.close();
  }
}
