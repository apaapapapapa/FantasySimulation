import { expect, it, vi } from 'vite-plus/test';
import { publicationLeagueSource as source } from '../apps/cli/test-support/leagues.ts';
import { CALIBRATION_TRIAL_BYTE_HOURS as trial } from './league-runner-calibration-policy.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  calibrationHistoryReservation,
  validateCalibrationBudgetRecord,
  segmentServiceHistoryReservation,
  reserveSegmentServiceTrial,
  reserveCalibrationTrial,
} from './league-calibration-history.ts';
import type { PipelineArtifacts } from './league-pipeline-artifacts.ts';
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

type HistoryFixtureRun = {
  id: number;
  run_attempt: number;
  created_at: string;
  updated_at: string;
  path: string;
  status?: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'failure' | 'success' | null;
};
const run = (id: number, attempt = 1, updated = '2026-10-01T11:40:00.000Z'): HistoryFixtureRun => ({
  id,
  run_attempt: attempt,
  created_at: '2026-09-30T00:00:00.000Z',
  updated_at: updated,
  path: '.github/workflows/league-runner-calibration.yml',
});

const serviceRun = (id: number, attempt = 1, updated?: string) => ({
  ...run(id, attempt, updated),
  path: '.github/workflows/league-segment-service.yml',
});
const historyPage = (runs: ReturnType<typeof run>[]) => [
  { total_count: runs.length, workflow_runs: runs },
];

it('charges both workflow histories including reruns, queued failures and current pre-observation attempt', () => {
  const calibration = historyPage([
    run(124, 2),
    { ...run(125), status: 'queued' },
    { ...run(126), conclusion: 'failure' },
  ]);
  const service = historyPage([serviceRun(123, 1, '2026-10-01T10:00:00.000Z'), serviceRun(127, 3)]);
  expect(
    segmentServiceHistoryReservation(calibration, service, identity, budget(8), now),
  ).toMatchObject({
    attempts: 8,
    requiredByteHours: 18522046464,
  });
  expect(() =>
    segmentServiceHistoryReservation(calibration, service, identity, budget(7), now),
  ).toThrow('exhausts');
});

it('excludes prior runs whose creation and update both precede the unchanged owner observation', () => {
  const calibration = historyPage([run(124, 9, '2026-10-01T10:00:00.000Z')]);
  const service = historyPage([serviceRun(123), serviceRun(125, 8, '2026-10-01T10:00:00.000Z')]);
  const observation = budget(1);
  const before = JSON.stringify(observation);
  expect(
    segmentServiceHistoryReservation(calibration, service, identity, observation, now).attempts,
  ).toBe(1);
  expect(JSON.stringify(observation)).toBe(before);
});

it.each([
  { calibration: historyPage([]), service: historyPage([]) },
  { calibration: historyPage([run(123)]), service: historyPage([serviceRun(123)]) },
  { calibration: historyPage([]), service: historyPage([serviceRun(123), serviceRun(123)]) },
  { calibration: historyPage([]), service: historyPage([serviceRun(123, 2)]) },
  {
    calibration: historyPage([]),
    service: historyPage([serviceRun(123, 1, '2026-10-01T12:00:00.001Z')]),
  },
  {
    calibration: historyPage([]),
    service: historyPage([{ ...serviceRun(123), created_at: '2026-10-01T12:00:00.001Z' }]),
  },
  { calibration: [{ total_count: 1, workflow_runs: [] }], service: historyPage([serviceRun(123)]) },
  { calibration: historyPage([]), service: historyPage([run(123)]) },
])(
  'fails closed on incomplete, duplicate, future or foreign dual history %j',
  ({ calibration, service }) => {
    expect(() =>
      segmentServiceHistoryReservation(calibration, service, identity, budget(20), now),
    ).toThrow();
  },
);

it('preserves budget freshness and exact source guards and refuses service reruns', () => {
  const service = historyPage([serviceRun(123)]);
  for (const observation of [
    { ...budget(1), observedAt: '2026-10-01T10:59:59.999Z' },
    { ...budget(1), observedAt: '2026-10-01T12:00:00.001Z' },
    { ...budget(1), sourceSha: '0'.repeat(40) },
    { ...budget(1), reserveByteHours: undefined },
  ])
    expect(() =>
      segmentServiceHistoryReservation(historyPage([]), service, identity, observation, now),
    ).toThrow();
  expect(() =>
    segmentServiceHistoryReservation(
      historyPage([]),
      historyPage([serviceRun(123, 2)]),
      { ...identity, runAttempt: 2 },
      budget(2),
      now,
    ),
  ).toThrow('first attempt');
});

it('collects both fixed workflows through the existing request owner and rechecks freshness', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const request = vi.fn(async (_route: string, params: { workflow_id: string }) =>
    params.workflow_id === 'league-runner-calibration.yml'
      ? historyPage([run(124)])[0]
      : historyPage([serviceRun(123)])[0],
  );
  try {
    const github = { request } as unknown as PipelineArtifacts;
    expect((await reserveSegmentServiceTrial(github, identity, budget(2))).attempts).toBe(2);
    expect(request.mock.calls.map(([, params]) => params.workflow_id)).toEqual([
      'league-runner-calibration.yml',
      'league-segment-service.yml',
    ]);
    request.mockImplementationOnce(async () => {
      vi.setSystemTime(now + 1800001);
      return historyPage([])[0];
    });
    await expect(reserveSegmentServiceTrial(github, identity, budget(2))).rejects.toThrow('stale');
  } finally {
    vi.useRealTimers();
  }
});

it('bounds both history reads to three pages and rejects incomplete third-page coverage', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const runs = Array.from({ length: 201 }, (_, index) => run(1000 + index));
  const service = historyPage([serviceRun(123)]);
  const request = vi.fn(async (_route: string, params: { workflow_id: string; page: number }) =>
    params.workflow_id === 'league-segment-service.yml'
      ? service[0]
      : {
          total_count: 201,
          workflow_runs: runs.slice((params.page - 1) * 100, params.page * 100),
        },
  );
  try {
    const github = { request } as unknown as PipelineArtifacts;
    expect((await reserveSegmentServiceTrial(github, identity, budget(202))).attempts).toBe(202);
    expect(request.mock.calls.map(([, params]) => [params.workflow_id, params.page])).toEqual([
      ['league-runner-calibration.yml', 1],
      ['league-runner-calibration.yml', 2],
      ['league-runner-calibration.yml', 3],
      ['league-segment-service.yml', 1],
    ]);
    expect(() =>
      segmentServiceHistoryReservation(
        [
          { total_count: 201, workflow_runs: runs.slice(0, 100) },
          { total_count: 201, workflow_runs: runs.slice(100, 200) },
          { total_count: 201, workflow_runs: [] },
        ],
        service,
        identity,
        budget(202),
        now,
      ),
    ).toThrow('incomplete');
  } finally {
    vi.useRealTimers();
  }
});

it('charges prior service attempts before admitting calibration under the same observation', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const calibration = historyPage([run(123)]);
  const service = historyPage([{ ...serviceRun(124, 2), conclusion: 'failure' }]);
  const request = vi.fn(async (_route: string, params: { workflow_id: string }) =>
    params.workflow_id === 'league-runner-calibration.yml' ? calibration[0] : service[0],
  );
  try {
    const github = { request } as unknown as PipelineArtifacts;
    // The legacy pure single-workflow API keeps its original contract.
    expect(calibrationHistoryReservation(calibration, identity, budget(1), now).attempts).toBe(1);
    await expect(reserveCalibrationTrial(github, identity, budget(2))).rejects.toThrow('exhausts');
    expect((await reserveCalibrationTrial(github, identity, budget(3))).attempts).toBe(3);
    expect(request.mock.calls.map(([, params]) => params.workflow_id)).toEqual([
      'league-runner-calibration.yml',
      'league-segment-service.yml',
      'league-runner-calibration.yml',
      'league-segment-service.yml',
    ]);
    await expect(reserveSegmentServiceTrial(github, identity, budget(3))).rejects.toThrow(
      'current attempt',
    );
  } finally {
    vi.useRealTimers();
  }
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
