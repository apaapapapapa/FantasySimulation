import { expect, it } from 'vite-plus/test';
import { collectLeagueTiming, leagueTiming, leagueTimingSummary } from './league-timing.ts';
it('keeps concurrent jobs separate, retains waits and never calls readback Pages acceptance', () => {
  const report = leagueTiming(
    {
      id: 17,
      run_attempt: 2,
      head_sha: 'a'.repeat(40),
      created_at: '2026-09-01T00:00:00Z',
      run_started_at: '2026-09-01T00:00:20Z',
    },
    [
      {
        id: 1,
        name: 'compute (0)',
        created_at: '2026-09-01T00:00:20Z',
        started_at: '2026-09-01T00:00:30Z',
        completed_at: '2026-09-01T00:01:30Z',
        conclusion: 'success',
      },
      {
        id: 2,
        name: 'compute (1)',
        started_at: '2026-09-01T00:00:40Z',
        completed_at: '2026-09-01T00:01:40Z',
        conclusion: 'success',
      },
      {
        id: 3,
        name: 'publish',
        started_at: '2026-09-01T00:01:40Z',
        completed_at: null,
        conclusion: null,
        steps: [
          {
            name: 'Reserve publication budget and verify R2 and Worker readback',
            started_at: '2026-09-01T00:01:45Z',
            completed_at: '2026-09-01T00:02:00Z',
            conclusion: 'success',
          },
        ],
      },
    ],
    '2026-09-01T00:02:10Z',
  );
  expect(report).toMatchObject({
    observedWallMs: 130000,
    workflowCreatedToStartedMs: 20000,
    createdToR2WorkerReadbackMs: 120000,
    requestToPagesMs: null,
    target300Seconds: 'unmeasured',
    runnerWaitMs: null,
    exclusiveWaitMs: null,
  });
  expect(report.jobs.map((j) => j.unseparatedBeforeStartMs)).toEqual([10000, null, null]);
  expect(report.jobs.map((j) => j.wallMs)).toEqual([60000, 60000, null]);
});
it('does not turn missing, reversed or invalid timestamps into zero or a successful endpoint', () => {
  const report = leagueTiming(
    { id: 2, run_attempt: 1, head_sha: 'b'.repeat(40), created_at: 'invalid' },
    [],
    '2026-09-01T00:00:00Z',
  );
  expect(report.observedWallMs).toBeNull();
  expect(report.createdToR2WorkerReadbackMs).toBeNull();
});
const pipelineRun = {
  id: 31,
  run_attempt: 1,
  head_sha: 'c'.repeat(40),
  created_at: '2026-09-01T00:00:00Z',
  run_started_at: '2026-09-01T00:00:03Z',
};
function pipelineJobs(acceptanceCompletedAt: string | null, conclusion = 'success') {
  return [
    {
      id: 1,
      name: 'transfer',
      started_at: '2026-09-01T00:00:25Z',
      completed_at: null,
      conclusion: null,
      steps: [
        {
          name: 'Stage while producers run, reconcile successful jobs, then conditionally commit',
          started_at: '2026-09-01T00:00:40Z',
          completed_at: '2026-09-01T00:04:20Z',
          conclusion: 'success',
        },
        {
          name: 'Accept the new snapshot in a fresh browser',
          started_at: '2026-09-01T00:04:21Z',
          completed_at: acceptanceCompletedAt,
          conclusion: acceptanceCompletedAt ? conclusion : null,
        },
      ],
    },
  ];
}
function pipelineEvidence(
  league: Record<string, unknown> = {},
  seen: Record<string, unknown> = {},
) {
  const catalogHash = 'sha256:' + '1'.repeat(64),
    snapshot = 'sha256:' + '2'.repeat(64);
  return {
    completion: {
      outcome: { status: 'verified' },
      catalogHash,
      recover: false,
      league: {
        id: 'official-20-v2',
        snapshot,
        status: 'formal',
        planned: 7600,
        resolved: 7600,
        reusedSlots: 0,
        ...league,
      },
    },
    acceptance: {
      status: 'accepted',
      catalogHash,
      league: { id: 'official-20-v2', snapshot },
      formal: true,
      planned: 7600,
      resolved: 7600,
      acceptedAt: '2026-09-01T00:04:38.500Z',
      ...seen,
    },
  };
}
it('ends at the acceptance step on the workflow clock and judges both targets', () => {
  const met = leagueTiming(
    pipelineRun,
    pipelineJobs('2026-09-01T00:04:40Z'),
    '2026-09-01T00:04:45Z',
    pipelineEvidence(),
  );
  expect(met).toMatchObject({
    createdToR2WorkerReadbackMs: 260000,
    pagesAcceptedAt: '2026-09-01T00:04:40Z',
    browserAcceptedAt: '2026-09-01T00:04:38.500Z',
    requestToPagesMs: 280000,
    target300Seconds: 'met',
    design270Seconds: 'exceeded',
    ineligibleReasons: [],
  });
  const late = leagueTiming(
    pipelineRun,
    pipelineJobs('2026-09-01T00:05:00.001Z'),
    '2026-09-01T00:05:05Z',
    pipelineEvidence(),
  );
  expect(late).toMatchObject({ requestToPagesMs: 300001, target300Seconds: 'exceeded' });
  expect(leagueTimingSummary(met)).toContain('300s target met, 270s design exceeded');
});
it.each([
  [{ reusedSlots: 1 }, {}, 'retained results were reused'],
  [{ status: 'provisional', resolved: 7599 }, { formal: false }, 'standings are not formal'],
  [{ planned: 24, resolved: 24 }, { planned: 24, resolved: 24 }, 'not all 7600 slots resolved'],
])('never counts a partial, reused or provisional league: %j', (league, seen, reason) => {
  const report = leagueTiming(
    pipelineRun,
    pipelineJobs('2026-09-01T00:01:00Z'),
    '2026-09-01T00:01:05Z',
    pipelineEvidence(league, seen),
  );
  expect(report).toMatchObject({ requestToPagesMs: 60000, target300Seconds: 'ineligible' });
  expect(report.ineligibleReasons).toContain(reason);
  expect(leagueTimingSummary(report)).toContain(reason);
});
it.each([
  ['a failed probe', pipelineJobs('2026-09-01T00:01:00Z', 'failure'), {}],
  ['an unreported step', pipelineJobs(null), {}],
  [
    'a stale catalog',
    pipelineJobs('2026-09-01T00:01:00Z'),
    { catalogHash: 'sha256:' + '3'.repeat(64) },
  ],
  [
    'another league',
    pipelineJobs('2026-09-01T00:01:00Z'),
    { league: { snapshot: 'sha256:' + '4'.repeat(64) } },
  ],
  ['a failed observation', pipelineJobs('2026-09-01T00:01:00Z'), { status: 'failed' }],
])('leaves %s unmeasured', (_, jobs, seen) => {
  const report = leagueTiming(
    pipelineRun,
    jobs,
    '2026-09-01T00:01:05Z',
    pipelineEvidence({}, seen),
  );
  expect(report).toMatchObject({
    pagesAcceptedAt: null,
    requestToPagesMs: null,
    target300Seconds: 'unmeasured',
    design270Seconds: 'unmeasured',
  });
});
it('re-reads a not yet reported acceptance step a bounded number of times', async () => {
  const evidence = pipelineEvidence(),
    waits: number[] = [];
  const report = (jobs: Parameters<typeof leagueTiming>[1]) =>
    leagueTiming(pipelineRun, jobs, '2026-09-01T00:04:45Z', evidence);
  const reported = [null, null, '2026-09-01T00:04:40Z'];
  const late = await collectLeagueTiming(
    async () => pipelineJobs(reported.shift() ?? null),
    report,
    true,
    async (ms) => void waits.push(ms),
  );
  expect(late.requestToPagesMs).toBe(280000);
  expect(waits).toEqual([3000, 3000]);
  waits.length = 0;
  const never = await collectLeagueTiming(
    async () => pipelineJobs(null),
    report,
    true,
    async (ms) => void waits.push(ms),
  );
  expect(never.target300Seconds).toBe('unmeasured');
  expect(waits).toHaveLength(4);
  waits.length = 0;
  await collectLeagueTiming(
    async () => pipelineJobs(null),
    report,
    false,
    async (ms) => {
      waits.push(ms);
    },
  );
  expect(waits).toEqual([]);
});
