import {
  BattlePool,
  validateLeaguePartition,
  validateLeagueReservation,
  validateLeaguePlan,
} from '@fantasy/api/tooling';
import { OperationError } from '@fantasy/api/artifacts';
import { canonicalJson, type ExecutionSource } from '@fantasy/domain/spatial';
import { join } from 'node:path';
import { preparedLeague, cloudInput } from './league-cloud-files.ts';
import { runCloudLeague } from './league-cloud.ts';
import { assignLeagueRunners } from './league-assignment.ts';
import { preparedLeagueCosts } from './league-cost-profile.ts';

/** One runner owns one pool and processes its fixed partition sequence to durable completion. */
export async function runCloudLeagueRunner(
  preparedRoot: string,
  outputRoot: string,
  source: ExecutionSource,
  executionId: string,
  options: {
    runner: number;
    runners: number;
    workers?: number;
    comparisonWorkers?: boolean;
    deadlineMs?: number;
    signal?: AbortSignal;
    completed?: (index: number, root: string, pool: BattlePool) => Promise<void>;
  },
) {
  const started = performance.now();
  const prepared = await preparedLeague(preparedRoot);
  await validateLeaguePlan(prepared.plan);
  if (
    canonicalJson(prepared.plan.source) !== canonicalJson(source) ||
    prepared.executionId !== executionId
  )
    throw new OperationError('IDENTITY_MISMATCH', 'Runner source/execution mismatch');
  const assignments = assignLeagueRunners(
    prepared.plan,
    options.runners,
    await preparedLeagueCosts(preparedRoot, prepared),
  );
  const assignment = assignments[options.runner];
  if (!Number.isInteger(options.runner) || !assignment)
    throw new OperationError('INPUT_INVALID', 'Invalid league runner index');
  const deadline = options.deadlineMs ?? 1500000;
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > 1800000)
    throw new OperationError('INPUT_INVALID', 'Invalid runner deadline');
  // Authenticate every assigned input before claiming or executing the first partition.
  for (const index of assignment.partitions) {
    const input = await cloudInput(preparedRoot, prepared, index);
    if (
      canonicalJson(input.plan) !== canonicalJson(prepared.plan) ||
      input.partition.id !== prepared.plan.partitions[index]!.partitionId ||
      input.reservation.executionId !== executionId ||
      canonicalJson(input.work) !== canonicalJson(prepared.work)
    )
      throw new OperationError('IDENTITY_MISMATCH', 'Assigned league input mismatch');
    await validateLeaguePartition(input.plan, input.partition, input.batch);
    await validateLeagueReservation(input.plan, input.partition, input.reservation);
  }
  const pool = new BattlePool(
    options.workers ?? 2,
    options.comparisonWorkers ? { comparison: true } : {},
  );
  const results = [];
  try {
    for (const index of assignment.partitions) {
      options.signal?.throwIfAborted();
      const remaining = Math.floor(deadline - (performance.now() - started));
      if (remaining <= 0)
        throw new OperationError('BUDGET_EXCEEDED', 'League runner deadline exceeded');
      const root = join(outputRoot, String(index));
      results.push(
        await runCloudLeague(
          join(preparedRoot, 'inputs', String(index)),
          root,
          source,
          executionId,
          options.signal,
          { pool, workers: pool.workers, deadlineMs: remaining },
        ),
      );
      await options.completed?.(index, root, pool);
    }
    return { assignment, results };
  } finally {
    await pool.close();
  }
}
