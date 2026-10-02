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

const calibrationPath = '.github/workflows/league-runner-calibration.yml';
const servicePath = '.github/workflows/league-segment-service.yml';
type HistoryPath = typeof calibrationPath | typeof servicePath;
const historySchemaFor = (path: HistoryPath) =>
  z.object({
    total_count: z.number().int().nonnegative().max(300),
    workflow_runs: z
      .array(
        z.object({
          id: z.number().int().positive().safe(),
          run_attempt: z.number().int().positive().max(99999),
          created_at: z.string().datetime(),
          updated_at: z.string().datetime(),
          path: z.literal(path),
        }),
      )
      .max(100),
  });
function parseHistory(input: unknown[], path: HistoryPath, now?: number) {
  const pages = input.map((page) => historySchemaFor(path).parse(page));
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
  if (
    now !== undefined &&
    runs.some(
      (run) =>
        Date.parse(run.created_at) > now ||
        Date.parse(run.updated_at) > now ||
        Date.parse(run.created_at) > Date.parse(run.updated_at),
    )
  )
    throw new Error('Service history timestamps are future or inconsistent');
  return runs;
}
type HistoryRun = ReturnType<typeof parseHistory>[number];
function historyCharge(
  runs: HistoryRun[],
  identity: PipelineIdentity,
  budgetInput: unknown,
  now: number,
) {
  const budget = validateCalibrationBudget(budgetInput, identity.source.sha, now);
  const observedAt = Date.parse(budget.observation.observedAt);
  // All attempts of updated/created/queued/failed runs are charged. No uncertain refunds.
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
export function calibrationHistoryReservation(
  input: unknown[],
  identity: PipelineIdentity,
  budgetInput: unknown,
  now = Date.now(),
) {
  // Preserve the original budget-first validation and single-workflow contract.
  validateCalibrationBudget(budgetInput, identity.source.sha, now);
  const runs = parseHistory(input, calibrationPath);
  const current = runs.find((run) => run.id === identity.runId);
  if (!current || current.run_attempt !== identity.runAttempt)
    throw new Error('Calibration history lacks current attempt');
  return historyCharge(runs, identity, budgetInput, now);
}
export function segmentServiceHistoryReservation(
  calibrationPages: unknown[],
  servicePages: unknown[],
  identity: PipelineIdentity,
  budgetInput: unknown,
  now = Date.now(),
) {
  return dualHistoryReservation(
    calibrationPages,
    servicePages,
    identity,
    budgetInput,
    now,
    servicePath,
  );
}
function dualHistoryReservation(
  calibrationPages: unknown[],
  servicePages: unknown[],
  identity: PipelineIdentity,
  budgetInput: unknown,
  now: number,
  currentPath: HistoryPath,
) {
  validateCalibrationBudget(budgetInput, identity.source.sha, now);
  const actualIdentity = LeaguePipelineIdentitySchema.parse(identity);
  if (currentPath === servicePath && actualIdentity.runAttempt !== 1)
    throw new Error('Service history requires first attempt');
  const calibration = parseHistory(calibrationPages, calibrationPath, now);
  const service = parseHistory(servicePages, servicePath, now);
  const current = (currentPath === servicePath ? service : calibration).find(
    (run) => run.id === actualIdentity.runId,
  );
  if (!current || current.run_attempt !== actualIdentity.runAttempt)
    throw new Error('Service history lacks current attempt');
  const runs = [...calibration, ...service];
  if (new Set(runs.map((run) => run.id)).size !== runs.length)
    throw new Error('Service history contains duplicate workflow run identities');
  return historyCharge(runs, actualIdentity, budgetInput, now);
}
async function collectHistory(github: PipelineArtifacts, path: HistoryPath) {
  const pages = [];
  for (let page = 1; page <= 3; page++) {
    const raw = await github.request(
      'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
      {
        workflow_id: path.slice('.github/workflows/'.length),
        per_page: 100,
        page,
      },
    );
    const parsed = historySchemaFor(path).parse(raw);
    pages.push(parsed);
    if (page * 100 >= parsed.total_count) break;
  }
  return pages;
}
/** Serialized by the dedicated workflow concurrency group, before any new SDK allocation. */
export async function reserveCalibrationTrial(
  github: PipelineArtifacts,
  identity: PipelineIdentity,
  budgetInput: unknown,
) {
  return reserveDualTrial(github, identity, budgetInput, calibrationPath);
}
/** The caller uses the common serialization group across both workflows. Requests debit its existing context. */
export async function reserveSegmentServiceTrial(
  github: PipelineArtifacts,
  identity: PipelineIdentity,
  budgetInput: unknown,
) {
  return reserveDualTrial(github, identity, budgetInput, servicePath);
}
async function reserveDualTrial(
  github: PipelineArtifacts,
  identity: PipelineIdentity,
  budgetInput: unknown,
  currentPath: HistoryPath,
) {
  validateCalibrationBudget(budgetInput, identity.source.sha);
  const calibration = await collectHistory(github, calibrationPath);
  const service = await collectHistory(github, servicePath);
  return dualHistoryReservation(
    calibration,
    service,
    identity,
    budgetInput,
    Date.now(),
    currentPath,
  );
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
