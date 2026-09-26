import { expect, it } from 'vite-plus/test';
import { leagueTiming } from './league-timing.ts';
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
