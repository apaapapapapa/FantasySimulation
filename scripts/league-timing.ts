/** GitHub timestamps are wall-clock observations, never sums of overlapping job durations. */
type Run = {
  id: number;
  run_attempt: number;
  head_sha: string;
  created_at: string;
  run_started_at?: string | null;
};
type Step = {
  name: string;
  started_at?: string | null;
  completed_at?: string | null;
  conclusion?: string | null;
};
type Job = {
  id: number;
  name: string;
  created_at?: string;
  started_at: string | null;
  completed_at: string | null;
  conclusion: string | null;
  steps?: Step[];
};
/** Pipeline completion and the fresh-browser observation written by the same transfer job. */
export type LeagueTimingEvidence = { completion?: unknown; acceptance?: unknown };
/** Issue #189 fixes the accepted league: 20 characters x 5 fields x 2 placements x 4 seeds. */
export const ACCEPTANCE_SLOTS = 7600;
export const PAGES_ACCEPTANCE_STEP = 'Accept the new snapshot in a fresh browser';
/** Steps that end only after every added object is proven and the bounded Reader readback. */
export const READBACK_STEPS = [
  ['publish', 'Reserve publication budget and verify R2 and Worker readback'],
  ['transfer', 'Stage while producers run, reconcile successful jobs, then conditionally commit'],
  ['recover', 'Authenticate original artifacts and finalize with fresh leases, without simulation'],
] as const;
const time = (value: string | null | undefined) =>
  value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const elapsed = (a: string | null | undefined, b: string | null | undefined) => {
  const start = time(a),
    end = time(b);
  return start !== null && end !== null && end >= start ? end - start : null;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const succeeded = (jobs: Job[], job: string, name: string) =>
  jobs
    .find((j) => j.name === job)
    ?.steps?.find((s) => s.name === name && s.conclusion === 'success' && time(s.completed_at));

/**
 * The end is GitHub's completion of the acceptance step: the clock that set created_at, and no
 * earlier than the browser's own acceptance. Only a matching verified publication counts.
 */
function pagesAcceptance(jobs: Job[], { completion, acceptance }: LeagueTimingEvidence) {
  const step = succeeded(jobs, 'transfer', PAGES_ACCEPTANCE_STEP),
    done = object(completion),
    seen = object(acceptance),
    league = object(done.league);
  if (
    !step ||
    seen.status !== 'accepted' ||
    object(done.outcome).status !== 'verified' ||
    typeof done.catalogHash !== 'string' ||
    seen.catalogHash !== done.catalogHash ||
    object(seen.league).snapshot !== league.snapshot ||
    typeof seen.acceptedAt !== 'string' ||
    time(seen.acceptedAt) === null
  )
    return null;
  const ineligible = [
    done.recover !== false && 'recovery reuses the original execution',
    (league.status !== 'formal' || seen.formal !== true) && 'standings are not formal',
    (league.planned !== ACCEPTANCE_SLOTS ||
      league.resolved !== ACCEPTANCE_SLOTS ||
      seen.planned !== ACCEPTANCE_SLOTS ||
      seen.resolved !== ACCEPTANCE_SLOTS) &&
      `not all ${ACCEPTANCE_SLOTS} slots resolved`,
    league.reusedSlots !== 0 && 'retained results were reused',
  ].filter((reason): reason is string => typeof reason === 'string');
  return { at: step.completed_at!, browserAcceptedAt: seen.acceptedAt, ineligible };
}
const verdict = (ms: number | null, ineligible: readonly string[] | undefined, limit: number) =>
  ms === null || !ineligible
    ? 'unmeasured'
    : ineligible.length
      ? 'ineligible'
      : ms <= limit
        ? 'met'
        : 'exceeded';

export function leagueTiming(
  run: Run,
  jobs: Job[],
  observedAt: string,
  evidence: LeagueTimingEvidence = {},
) {
  const readback = READBACK_STEPS.map(([job, name]) => succeeded(jobs, job, name)).find(Boolean);
  const pages = pagesAcceptance(jobs, evidence);
  const requestToPagesMs = pages ? elapsed(run.created_at, pages.at) : null;
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
    r2WorkerReadbackAt: readback?.completed_at ?? null,
    createdToR2WorkerReadbackMs: readback ? elapsed(run.created_at, readback.completed_at) : null,
    pagesAcceptedAt: requestToPagesMs === null ? null : pages!.at,
    browserAcceptedAt: requestToPagesMs === null ? null : pages!.browserAcceptedAt,
    requestToPagesMs,
    target300Seconds: verdict(requestToPagesMs, pages?.ineligible, 300000),
    design270Seconds: verdict(requestToPagesMs, pages?.ineligible, 270000),
    ineligibleReasons: pages?.ineligible ?? [],
    // Contract, not measurement: an already-open browser may reuse the old pointer this long.
    openBrowserPointerMaxAgeMs: 30000,
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
export type LeagueTimingReport = ReturnType<typeof leagueTiming>;

/** The acceptance step may not be reported yet; bounded re-reads never invent an end. */
export async function collectLeagueTiming(
  jobs: () => Promise<Job[]>,
  report: (jobs: Job[]) => LeagueTimingReport,
  accepted: boolean,
  wait = (ms: number) => new Promise((settle) => setTimeout(settle, ms)),
) {
  let value = report(await jobs());
  for (let retry = 0; accepted && value.pagesAcceptedAt === null && retry < 4; retry++) {
    await wait(3000);
    value = report(await jobs());
  }
  return value;
}
export function leagueTimingSummary(report: LeagueTimingReport) {
  const ms = (value: number | null) => (value === null ? 'unmeasured' : `${value} ms`);
  const reasons = report.ineligibleReasons.length
    ? ` (${report.ineligibleReasons.join('; ')})`
    : '';
  return [
    `Created to observation: ${ms(report.observedWallMs)}.`,
    `Created to R2/Worker readback: ${ms(report.createdToR2WorkerReadbackMs)}.`,
    `Created to fresh-browser Pages acceptance: ${ms(report.requestToPagesMs)};`,
    `300s target ${report.target300Seconds}${reasons}, 270s design ${report.design270Seconds}.`,
    'An already-open browser may show the old pointer for up to 30 s (cache contract, unmeasured).',
    'Runner, Environment and concurrency waits are included but not separated. Inclusive process spans and overlapping jobs must not be added to wall time.',
  ].join(' ');
}
