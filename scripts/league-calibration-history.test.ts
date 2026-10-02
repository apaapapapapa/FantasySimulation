import { expect, it, vi } from 'vite-plus/test';
import { publicationLeagueSource as source } from '../apps/cli/test-support/leagues.ts';
import { CALIBRATION_TRIAL_BYTE_HOURS as trial } from './league-runner-calibration-policy.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  calibrationHistoryReservation,
  validateCalibrationBudgetRecord,
} from './league-calibration-history.ts';
const now = Date.parse('2026-10-01T12:00:00.000Z');
const identity = { source, runId: 123, runAttempt: 1, validatorDigest: 'sha256:' + 'b'.repeat(64) };
const budget = (trials: number) => ({
  schemaVersion: 1,
  kind: 'owner-attestation',
  sourceSha: source.sha,
  accountLogin: 'apaapapapapa',
  observedAt: '2026-10-01T11:30:00.000Z',
  retentionDays: 1,
  artifactByteHoursRemaining: trials * trial + 101,
  competingWorkloadByteHours: 100,
  reserveByteHours: 1,
  readproofEvidenceURL: 'https://github.com/settings/billing/usage',
});
const run = (id: number, attempt = 1, updated = '2026-10-01T11:40:00.000Z') => ({
  id,
  run_attempt: attempt,
  created_at: '2026-09-30T00:00:00.000Z',
  updated_at: updated,
  path: '.github/workflows/league-runner-calibration.yml',
});
it('charges all ABBA attempts and exactly refuses the next trial without changing the budget', () => {
  const runs = [run(123), run(124), run(125), run(126)];
  expect(
    calibrationHistoryReservation(
      [{ total_count: 4, workflow_runs: runs }],
      identity,
      budget(4),
      now,
    ).attempts,
  ).toBe(4);
  expect(() =>
    calibrationHistoryReservation(
      [{ total_count: 4, workflow_runs: runs }],
      identity,
      budget(3),
      now,
    ),
  ).toThrow('exhausts');
  expect(() =>
    calibrationHistoryReservation(
      [{ total_count: 5, workflow_runs: [...runs, run(127)] }],
      identity,
      budget(4),
      now,
    ),
  ).toThrow('exhausts');
});
it('counts old reruns and all uncertain attempts while ignoring history predating the observation', () => {
  const runs = [run(123), run(124, 3), run(125, 9, '2026-10-01T10:00:00.000Z')];
  expect(
    calibrationHistoryReservation(
      [{ total_count: 3, workflow_runs: runs }],
      identity,
      budget(4),
      now,
    ).attempts,
  ).toBe(4);
});
it('fails closed on missing pagination, duplicates, changing counts, foreign workflows and absent current attempt', () => {
  for (const pages of [
    [{ total_count: 2, workflow_runs: [run(123)] }],
    [{ total_count: 2, workflow_runs: [run(123), run(123)] }],
    [
      { total_count: 1, workflow_runs: [run(123)] },
      { total_count: 2, workflow_runs: [] },
    ],
    [{ total_count: 1, workflow_runs: [run(124)] }],
    [{ total_count: 1, workflow_runs: [{ ...run(123), path: '.github/workflows/league.yml' }] }],
    [{ total_count: 1, workflow_runs: [run(123, 2)] }],
  ])
    expect(() => calibrationHistoryReservation(pages, identity, budget(4), now)).toThrow();
});
it('binds later phases to the immutable owner observation and complete source/run/validator identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'calibration-budget-'));
  const observation = { ...budget(4), observedAt: new Date().toISOString() };
  const record = { schemaVersion: 1, identity, attempts: 1, requiredByteHours: trial, observation };
  vi.stubEnv('LEAGUE_CALIBRATION_BUDGET', JSON.stringify(observation));
  try {
    const file = join(root, 'calibration-budget.json');
    await writeFile(file, JSON.stringify(record));
    expect(await validateCalibrationBudgetRecord(root, identity)).toEqual(record);
    await expect(
      validateCalibrationBudgetRecord(root, { ...identity, runAttempt: 2 }),
    ).rejects.toThrow('reservation mismatch');
    await expect(
      validateCalibrationBudgetRecord(root, {
        ...identity,
        validatorDigest: 'sha256:' + 'c'.repeat(64),
      }),
    ).rejects.toThrow('reservation mismatch');
    await writeFile(file, JSON.stringify({ ...record, attempts: 2 }));
    await expect(validateCalibrationBudgetRecord(root, identity)).rejects.toThrow(
      'reservation mismatch',
    );
    await writeFile(
      file,
      JSON.stringify({ ...record, observation: { ...observation, reserveByteHours: 2 } }),
    );
    await expect(validateCalibrationBudgetRecord(root, identity)).rejects.toThrow(
      'reservation mismatch',
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
