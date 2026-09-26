import { OperationError } from '../operation-error.ts';
import {
  contentHash,
  canonicalJson,
  parseJson,
  LeaguePartitionResultSchema,
  type LeagueAttempt,
  type LeaguePartitionResult,
  type LeaguePlan,
} from '@fantasy/domain/spatial';
import { aggregateLeague, aggregateStoredLeague, leagueMatches } from '@fantasy/engine/spatial';
import { checkedBatch } from '../batch/batch-check.ts';
import type { BattleBundles } from '../batch/battle-bundle.ts';
import { validateLeaguePlan, validateLeaguePartition } from './league-plan.ts';
import {
  storedLeagueInputs,
  storedResultPartition,
  storedLeagueBundleBinding,
} from './league-stored.ts';
import {
  validateProgressPage,
  validateLeagueReservation,
  verifyLeagueProgress,
} from './league-progress.ts';

export type LeagueCheckInput = {
  partition: unknown;
  batch: unknown;
  reservation: unknown;
  result: unknown;
  bundles: BattleBundles;
};
export async function checkLeague(input: unknown, completed: readonly LeagueCheckInput[]) {
  const plan = await validateLeaguePlan(input);
  return checkLeagueData(plan, completed);
}

/** Read saved plans/results without admitting them for execution on the installed engine. */
export async function checkStoredLeague(
  input: unknown,
  partitions: readonly { partition: unknown; batch: unknown }[],
  completed: readonly LeagueCheckInput[],
) {
  const stored = await storedLeagueInputs(input, partitions);
  return {
    ...(await checkLeagueData(stored.plan, completed, stored)),
    partitions: stored.partitions,
  };
}

async function checkLeagueData(
  plan: LeaguePlan,
  completed: readonly LeagueCheckInput[],
  stored?: Awaited<ReturnType<typeof storedLeagueInputs>>,
) {
  if (completed.length > plan.partitions.length)
    throw new OperationError('DATA_INVALID', 'Excessive league results');
  const seen = new Set<number>(),
    attempts: LeagueAttempt[] = [],
    results: LeaguePartitionResult[] = [];
  for (const entry of completed) {
    const { partition, batch } = stored
      ? storedResultPartition(stored, entry)
      : await validateLeaguePartition(plan, entry.partition, entry.batch);
    const bind = stored ? storedLeagueBundleBinding(batch, entry.bundles) : undefined;
    if (seen.has(partition.index))
      throw new OperationError('DATA_INVALID', 'Duplicate league partition result');
    seen.add(partition.index);
    const reservation = await validateLeagueReservation(plan, partition, entry.reservation);
    const result = parseJson(LeaguePartitionResultSchema, entry.result),
      { id, ...body } = result;
    if (id !== (await contentHash(body)))
      throw new OperationError('DATA_INVALID', 'League result checksum mismatch');
    if (result.reservationId !== reservation.id)
      throw new OperationError('DATA_INVALID', 'Result reservation mismatch');
    await validateProgressPage(result.progress);
    const progress = await verifyLeagueProgress(result.progress.records, entry.bundles);
    const checked = await checkedBatch(batch, [{ index: result.index, bundles: entry.bundles }]);
    if (progress.size !== partition.slots.length)
      throw new OperationError('DATA_INVALID', 'Result progress coverage mismatch');
    for (const slot of partition.slots) {
      const history = progress.get(slot.simulationHash),
        batchSlot = batch.slots.find((s) => s.key === slot.id.slice(7))!;
      const latest = history?.attempts.at(-1),
        recorded = checked.found.get(batchSlot.id)!;
      if (!history || (latest?.objectHash ?? null) !== (recorded.receipt?.objectHash ?? null))
        throw new OperationError('DATA_INVALID', 'Result and progress receipt mismatch');
      const reserved = reservation.progress.records.find(
        (r) => r.simulationHash === slot.simulationHash,
      )!;
      const last = reserved.attempts.at(-1);
      const admitted = last?.state === 'reserved' && last.executionId === reservation.executionId;
      const before = admitted ? reserved.attempts.slice(0, -1) : reserved.attempts;
      const previousState = before.at(-1)?.state;
      const unchangedState = !previousState
        ? 'pending'
        : previousState === 'unresolved' || previousState === 'truncated'
          ? previousState
          : 'failed';
      if (
        canonicalJson(history.attempts.slice(0, before.length)) !== canonicalJson(before) ||
        (!admitted && canonicalJson(history.attempts) !== canonicalJson(before)) ||
        (admitted &&
          history.attempts.length === before.length &&
          recorded.state !== unchangedState) ||
        (admitted &&
          history.attempts.length !== before.length &&
          (history.attempts.length !== before.length + 1 ||
            latest?.state === 'reserved' ||
            latest?.executionId !== last.executionId ||
            latest?.attempt !== last.attempt))
      )
        throw new OperationError('DATA_INVALID', 'Result rewrites reserved attempt history');
      for (const attempt of history.attempts) {
        const receipt = attempt.objectHash ? await entry.bundles.verify(attempt.objectHash) : null;
        if (receipt && bind) await bind(batchSlot, receipt);
        let outcome: LeagueAttempt['outcome'];
        if (receipt?.result.outcome.kind === 'win') {
          const winner = receipt.result.outcome.winner;
          const actor = batchSlot.spec.participants.find((p) => p.actorId === winner);
          if (!actor)
            throw new OperationError(
              'DATA_INVALID',
              'League winner does not belong to planned match',
            );
          outcome = { kind: 'win', winner: actor.character.id, resultHash: receipt.resultHash };
        } else if (receipt?.result.outcome.kind === 'draw')
          outcome = { kind: 'draw', resultHash: receipt.resultHash };
        else
          outcome = {
            kind:
              attempt.state === 'reserved'
                ? 'cancelled'
                : (attempt.state as 'failed' | 'cancelled' | 'truncated' | 'unresolved'),
          };
        attempts.push({
          slotId: slot.id,
          simulationHash: slot.simulationHash,
          attempt: attempt.attempt,
          outcome,
        });
      }
      if (recorded.state === 'complete' && latest?.state !== 'win' && latest?.state !== 'draw')
        throw new OperationError('DATA_INVALID', 'Completed row lacks a definitive attempt');
    }
    results.push(result);
  }
  const slots = stored?.slots ?? [];
  if (!stored) for await (const { slot } of leagueMatches(plan.revision)) slots.push(slot);
  return {
    plan,
    slots,
    attempts,
    results,
    standings: await (stored ? aggregateStoredLeague : aggregateLeague)(
      plan.revision,
      slots,
      attempts,
    ),
    missingPartitions: plan.partitions.flatMap((_, i) => (seen.has(i) ? [] : [i])),
  };
}
