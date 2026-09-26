/** GitHub timestamps are wall-clock observations, never sums of overlapping job durations. */
type Run = {
  id: number;
  run_attempt: number;
  head_sha: string;
  created_at: string;
  run_started_at?: string | null;
};
type Job = {
  id: number;
  name: string;
  created_at?: string;
  started_at: string | null;
  completed_at: string | null;
  conclusion: string | null;
  steps?: {
    name: string;
    started_at?: string | null;
    completed_at?: string | null;
    conclusion?: string | null;
  }[];
};
const time = (value: string | null | undefined) =>
  value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const elapsed = (a: string | null | undefined, b: string | null | undefined) => {
  const start = time(a),
    end = time(b);
  return start !== null && end !== null && end >= start ? end - start : null;
};
export function leagueTiming(run: Run, jobs: Job[], observedAt: string) {
  const publish = jobs.find((j) => j.name === 'publish');
  const readback = publish?.steps?.find(
    (s) => s.name === 'Reserve publication budget and verify R2 and Worker readback',
  );
  return {
    schemaVersion: 1,
    sourceSha: run.head_sha,
    runId: run.id,
    runAttempt: run.run_attempt,
    workflowCreatedAt: run.created_at,
    runStartedAt: run.run_started_at ?? null,
    observedAt,
    workflowCreatedToStartedMs: elapsed(run.created_at, run.run_started_at),
    observedWallMs: elapsed(run.created_at, observedAt),
    r2WorkerReadbackAt: readback?.conclusion === 'success' ? (readback.completed_at ?? null) : null,
    createdToR2WorkerReadbackMs:
      readback?.conclusion === 'success' ? elapsed(run.created_at, readback.completed_at) : null,
    // Existing readback is not the fresh-browser Pages acceptance required by #189.
    pagesAcceptedAt: null,
    requestToPagesMs: null,
    target300Seconds: 'unmeasured',
    requestedAt: null,
    scheduledAt: null,
    runnerWaitMs: null,
    environmentWaitMs: null,
    exclusiveWaitMs: null,
    waitingReason:
      'GitHub job creation/start and workflow creation/start do not identify runner, Environment, dependency and concurrency waits separately. Keep them unseparated, included in observed wall time.',
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      createdAt: job.created_at ?? null,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      conclusion: job.conclusion,
      unseparatedBeforeStartMs: elapsed(job.created_at, job.started_at),
      wallMs: elapsed(job.started_at, job.completed_at),
      steps: (job.steps ?? []).map((step) => ({
        name: step.name,
        startedAt: step.started_at ?? null,
        completedAt: step.completed_at ?? null,
        conclusion: step.conclusion ?? null,
        wallMs: elapsed(step.started_at, step.completed_at),
      })),
    })),
  };
}
