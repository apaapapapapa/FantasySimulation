import { join } from 'node:path';
import { canonicalJson, LeaguePipelineIdentitySchema } from '@fantasy/domain/spatial';
import { cloudJson } from '../apps/cli/src/league/league-cloud-files.ts';
import { requiredPipeline } from './league-pipeline-context.ts';
import { z } from 'zod';
import {
  CALIBRATION_TRIAL_BYTE_HOURS,
  validateCalibrationBudget,
} from './league-runner-calibration-policy.ts';
import type { PipelineArtifacts } from './league-pipeline-artifacts.ts';
import type { PipelineIdentity } from '../apps/cli/src/league/league-producer.ts';

const historySchema = z.object({
  total_count: z.number().int().nonnegative().max(300),
  workflow_runs: z
    .array(
      z.object({
        id: z.number().int().positive().safe(),
        run_attempt: z.number().int().positive().max(99999),
        created_at: z.string().datetime(),
        updated_at: z.string().datetime(),
        path: z.literal('.github/workflows/league-runner-calibration.yml'),
      }),
    )
    .max(100),
});
export function calibrationHistoryReservation(
  input: unknown[],
  identity: PipelineIdentity,
  budgetInput: unknown,
  now = Date.now(),
) {
  const budget = validateCalibrationBudget(budgetInput, identity.source.sha, now);
  const pages = input.map((page) => historySchema.parse(page));
  const total = pages[0]?.total_count;
  const runs = pages.flatMap((page) => page.workflow_runs);
  if (
    total === undefined ||
    pages.length < 1 ||
    pages.length > 3 ||
    pages.some((page) => page.total_count !== total) ||
    runs.length !== total ||
    new Set(runs.map((run) => run.id)).size !== total
  )
    throw new Error('Calibration history is incomplete or changed during collection');
  const current = runs.find((run) => run.id === identity.runId);
  if (!current || current.run_attempt !== identity.runAttempt)
    throw new Error('Calibration history lacks current attempt');
  const observedAt = Date.parse(budget.observation.observedAt);
  // Conservatively charge every attempt of any run updated since the observation. This includes
  // older reruns, failures and queued runs; uncertain attempts never receive a refund.
  const attempts = runs.reduce(
    (count, run) =>
      count +
      (run.id === identity.runId ||
      Date.parse(run.updated_at) >= observedAt ||
      Date.parse(run.created_at) >= observedAt
        ? run.run_attempt
        : 0),
    0,
  );
  const requiredByteHours = BigInt(attempts) * BigInt(CALIBRATION_TRIAL_BYTE_HOURS);
  if (requiredByteHours > BigInt(budget.remainingAfterReserves))
    throw new Error('Calibration history exhausts declared byte-hour headroom');
  return {
    attempts,
    requiredByteHours: Number(requiredByteHours),
    observation: budget.observation,
  };
}
/** Serialized by the dedicated workflow concurrency group, before any new SDK allocation. */
export async function reserveCalibrationTrial(
  github: PipelineArtifacts,
  identity: PipelineIdentity,
  budgetInput: unknown,
) {
  const pages = [];
  for (let page = 1; page <= 3; page++) {
    const raw = await github.request(
      'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
      {
        workflow_id: 'league-runner-calibration.yml',
        per_page: 100,
        page,
      },
    );
    const parsed = historySchema.parse(raw);
    pages.push(parsed);
    if (page * 100 >= parsed.total_count) break;
  }
  return calibrationHistoryReservation(pages, identity, budgetInput);
}
const recordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: LeaguePipelineIdentitySchema,
  attempts: z
    .number()
    .int()
    .positive()
    .max(300 * 99999),
  requiredByteHours: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observation: z.unknown(),
});
/** This file travels inside the authenticated immutable inputs and baseline archives. */
export async function validateCalibrationBudgetRecord(root: string, identity: PipelineIdentity) {
  const record = recordSchema.parse(await cloudJson(join(root, 'calibration-budget.json')));
  const budget = validateCalibrationBudget(record.observation, identity.source.sha);
  if (
    canonicalJson(record.identity) !== canonicalJson(identity) ||
    canonicalJson(record.observation) !==
      canonicalJson(JSON.parse(requiredPipeline('LEAGUE_CALIBRATION_BUDGET'))) ||
    BigInt(record.requiredByteHours) !==
      BigInt(record.attempts) * BigInt(CALIBRATION_TRIAL_BYTE_HOURS) ||
    BigInt(record.requiredByteHours) > BigInt(budget.remainingAfterReserves)
  )
    throw new Error('Calibration immutable budget reservation mismatch');
  return record;
}
