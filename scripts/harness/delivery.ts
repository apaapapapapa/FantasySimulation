import { createHash } from 'node:crypto';
import { assessReport, identity, parseReport, record, sha, text, timestamp } from './report.ts';
import type { Check, Identity, Report } from './report.ts';
import { parsePlan } from '../ci/plan.ts';
import { DOCS_CHECKS } from '../ci/docs.ts';
import type { Plan } from '../ci/plan.ts';
import { SECURITY_CHECKS } from '../security/evidence.ts';
import { CORPUS_ARTIFACT_CHECK } from './corpus-compare.ts';
import { LOAD_JOBS, LOAD_MATRIX_JOB } from './load-contract.ts';
import { UI_JOBS, UI_MATRIX_JOB } from '../../e2e/contract.ts';

/** Full plans: ci-gate aggregates the Linux task receipts and prints their source report. */
export const SOURCE_REPORT_JOBS = ['ci-gate'] as const;
export const DOCS_JOBS = ['Docs (ubuntu-latest)'] as const;
export type DeliveryTarget = 'pr' | 'merge';
export interface RunEvidence {
  before: unknown;
  after: unknown;
  jobs: unknown[];
  sources: { jobId: number; report: unknown; logDigest: string }[];
  commits: Record<string, unknown>;
  plan?: { jobId: number; value: unknown; logDigest: string };
  gate?: { jobId: number; report: unknown; logDigest: string };
}
export interface DeliverySnapshot {
  schemaVersion: 1;
  repository: string;
  number: number;
  startedAt: string;
  finishedAt: string;
  pull: unknown;
  pullAfter: unknown;
  comments: unknown[];
  reviews: unknown[];
  files: unknown[];
  threads: unknown[];
  reviewDecision: string | null;
  prRuns: unknown[];
  prRunsAfter: unknown[];
  mainRuns: unknown[];
  mainRunsAfter: unknown[];
  prRun: RunEvidence | null;
  mainRun: RunEvidence | null;
  checks: unknown[];
  statuses: unknown[];
  errors: string[];
}
export interface ReviewReceipt {
  candidateSha: string;
  conversationDigest: string;
  reviewedPaths: string[];
  completedAt: string;
  method: 'self' | 'human';
  summary: string;
  unresolvedFindings: number;
  squashTitle: string;
  squashBody: string;
}
function issueWordingStatus(pull: Record<string, unknown>, receipt: unknown): Check['status'] {
  const planned = receipt === null ? {} : record(receipt);
  const wording = [
    pull.title,
    pull.body === null ? '' : pull.body,
    planned.squashTitle,
    planned.squashBody,
  ];
  const closingReference =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*(?:(?:[\w.-]+\/[\w.-]+)?#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)/i;
  if (wording.some((value) => typeof value === 'string' && closingReference.test(value)))
    return 'fail';
  return wording.some((value) => typeof value !== 'string') ||
    [pull.title, planned.squashTitle].some((value) => typeof value !== 'string' || !value.trim())
    ? 'unknown'
    : 'pass';
}
export function repositoryName(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error('Invalid repository');
  return value;
}
export function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10_000)
    throw new Error('Invalid or excessive collection');
  return value.map(record);
}
export function natural(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid count');
  return value;
}
export function newestRun(values: unknown[], candidate: string, event: 'push' | 'pull_request') {
  return (
    objects(values)
      .filter(
        (run) =>
          run.head_sha === candidate &&
          run.event === event &&
          run.path === '.github/workflows/ci.yml',
      )
      .sort(
        (a, b) => natural(b.id) - natural(a.id) || natural(b.run_attempt) - natural(a.run_attempt),
      )[0] ?? null
  );
}
function pullIdentity(value: unknown) {
  const pull = record(value);
  return {
    head: sha(record(pull.head).sha),
    base: sha(record(pull.base).sha),
    merge: pull.merged === true ? sha(pull.merge_commit_sha) : null,
    updated: timestamp(pull.updated_at),
    state: text(pull.state),
    merged: pull.merged,
    title: pull.title,
    body: pull.body,
  };
}
function stable(a: unknown, b: unknown): boolean {
  return JSON.stringify(pullIdentity(a)) === JSON.stringify(pullIdentity(b));
}
/** Receipt covers every conversation/review/thread body and changed-file entry. */
export function conversationDigest(snapshot: DeliverySnapshot): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        candidateSha: pullIdentity(snapshot.pull).head,
        title: record(snapshot.pull).title,
        body: record(snapshot.pull).body,
        comments: snapshot.comments,
        reviews: snapshot.reviews,
        threads: snapshot.threads,
        files: snapshot.files,
        reviewDecision: snapshot.reviewDecision,
      }),
    )
    .digest('hex');
}
export function parseSnapshot(value: unknown): DeliverySnapshot {
  const data = record(value);
  if (data.schemaVersion !== 1) throw new Error('Unsupported delivery schema');
  repositoryName(text(data.repository));
  if (natural(data.number) < 1) throw new Error('Invalid pull request number');
  timestamp(data.startedAt);
  timestamp(data.finishedAt);
  if (Date.parse(text(data.finishedAt)) < Date.parse(text(data.startedAt)))
    throw new Error('Invalid interval');
  pullIdentity(data.pull);
  pullIdentity(data.pullAfter);
  for (const key of [
    'comments',
    'reviews',
    'files',
    'threads',
    'prRuns',
    'prRunsAfter',
    'mainRuns',
    'mainRunsAfter',
    'checks',
    'statuses',
  ])
    objects(data[key]);
  if (
    data.reviewDecision !== null &&
    (typeof data.reviewDecision !== 'string' ||
      !['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(data.reviewDecision))
  )
    throw new Error('Invalid review decision');
  if (!Array.isArray(data.errors) || data.errors.some((error) => typeof error !== 'string'))
    throw new Error('Invalid collection errors');
  for (const key of ['prRun', 'mainRun']) {
    if (data[key] === null) continue;
    const run = record(data[key]);
    record(run.before);
    record(run.after);
    objects(run.jobs);
    objects(run.sources);
    record(run.commits);
  }
  return data as unknown as DeliverySnapshot;
}
function reviewInputsChangedAt(snapshot: DeliverySnapshot): number {
  const dates = [
    record(snapshot.pull).updated_at,
    ...objects(snapshot.comments).map((comment) => comment.updated_at),
    ...objects(snapshot.reviews).map((review) => review.submitted_at),
    ...objects(snapshot.threads).flatMap((thread) =>
      objects(thread.comments).map((comment) => comment.updatedAt),
    ),
  ].filter((date) => date !== undefined && date !== null);
  return Math.max(0, ...dates.map((date) => Date.parse(timestamp(date))));
}
function reviewReceiptValid(snapshot: DeliverySnapshot, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const receipt = record(value);
  const paths = objects(snapshot.files)
    .map((file) => text(file.filename))
    .sort();
  if (
    !Array.isArray(receipt.reviewedPaths) ||
    receipt.reviewedPaths.some((path) => typeof path !== 'string')
  )
    return false;
  const reviewed = [...new Set(receipt.reviewedPaths.map(text))].sort();
  return (
    sha(receipt.candidateSha) === pullIdentity(snapshot.pull).head &&
    receipt.conversationDigest === conversationDigest(snapshot) &&
    JSON.stringify(reviewed) === JSON.stringify(paths) &&
    ['self', 'human'].includes(String(receipt.method)) &&
    text(receipt.summary).length > 0 &&
    receipt.unresolvedFindings === 0 &&
    Date.parse(timestamp(receipt.completedAt)) >= reviewInputsChangedAt(snapshot) &&
    Date.parse(timestamp(receipt.completedAt)) <= Date.now()
  );
}
export function validateRun(
  snapshot: DeliverySnapshot,
  evidence: RunEvidence | null,
  main: boolean,
): { status: Check['status']; reason: string } {
  const info = pullIdentity(snapshot.pull);
  const candidate = main ? info.merge : info.head;
  if (!candidate || !evidence) return { status: 'unknown', reason: 'CI evidence missing' };
  const newest = newestRun(
    main ? snapshot.mainRuns : snapshot.prRuns,
    candidate,
    main ? 'push' : 'pull_request',
  );
  const afterNewest = newestRun(
    main ? snapshot.mainRunsAfter : snapshot.prRunsAfter,
    candidate,
    main ? 'push' : 'pull_request',
  );
  const before = record(evidence.before);
  const after = record(evidence.after);
  if (
    !newest ||
    !afterNewest ||
    newest.id !== before.id ||
    afterNewest.id !== before.id ||
    newest.run_attempt !== before.run_attempt ||
    afterNewest.run_attempt !== before.run_attempt ||
    before.id !== after.id ||
    before.run_attempt !== after.run_attempt ||
    before.head_sha !== candidate ||
    after.head_sha !== candidate ||
    before.path !== '.github/workflows/ci.yml' ||
    before.event !== (main ? 'push' : 'pull_request') ||
    (main && before.head_branch !== 'main')
  )
    return { status: 'unknown', reason: 'Latest CI identity or attempt changed' };
  if (
    after.conclusion === 'failure' ||
    after.conclusion === 'timed_out' ||
    after.conclusion === 'cancelled'
  )
    return { status: 'fail', reason: `CI ${String(after.conclusion)}` };
  if (after.status !== 'completed' || after.conclusion !== 'success')
    return { status: 'unknown', reason: 'CI not completed successfully' };
  const jobs = objects(evidence.jobs);
  let plan: Plan | null = null;
  const planned = jobs.some((job) => job.name === 'changes' || job.name === 'ci-gate');
  if (planned) {
    if (!evidence.plan || !evidence.gate)
      return { status: 'unknown', reason: 'CI plan or aggregate evidence missing' };
    plan = parsePlan(evidence.plan.value);
    const gate = parseReport(evidence.gate.report);
    const ids = [
      'changes',
      'security',
      'dependency-policy',
      'tasks',
      'corpus',
      'load',
      'docs',
      'ui',
    ].map((name) => `ci-job:${name}`);
    ids.push('ci-evidence:security', ...SECURITY_CHECKS);
    if (plan.ui) ids.push('ci-evidence:ui');
    if (plan.simulation) ids.push(CORPUS_ARTIFACT_CHECK);
    if (plan.load) ids.push('ci-evidence:load-pair');
    ids.push(
      ...(plan.full ? ['ubuntu-latest'] : ['docs-ubuntu-latest']).map(
        (name) => `ci-evidence:${name}`,
      ),
    );
    for (const [name, receipt] of [
      ['changes', evidence.plan],
      ['ci-gate', evidence.gate],
    ] as const) {
      const matched = jobs.filter((job) => job.name === name);
      const job = matched[0];
      if (
        matched.length !== 1 ||
        !job ||
        job.id !== receipt.jobId ||
        job.run_id !== before.id ||
        job.run_attempt !== before.run_attempt ||
        job.status !== 'completed' ||
        job.conclusion !== 'success' ||
        !/^[a-f0-9]{64}$/.test(receipt.logDigest)
      )
        return {
          status: 'unknown',
          reason: 'CI plan/gate belongs to an incomplete or different attempt',
        };
    }
    if (
      plan.candidateSha !== candidate ||
      plan.event !== (main ? 'push' : 'pull_request') ||
      (main && !plan.full) ||
      gate.producer !== 'ci-gate' ||
      gate.sourceSha !== plan.sourceSha ||
      gate.candidateSha !== plan.candidateSha ||
      gate.testMergeSha !== plan.testMergeSha ||
      gate.baselineSha !== plan.baselineSha ||
      assessReport(gate, ids).exitCode !== 0
    )
      return {
        status: 'unknown',
        reason: 'CI plan/gate does not authorize this revision and job coverage',
      };
  }
  let testedSource: string | null = null;
  for (const name of plan?.full === false ? DOCS_JOBS : SOURCE_REPORT_JOBS) {
    const matching = jobs.filter((job) => job.name === name);
    if (matching.length !== 1) return { status: 'unknown', reason: `Missing or ambiguous ${name}` };
    const job = matching[0]!;
    if (job.run_id !== before.id || job.run_attempt !== before.run_attempt)
      return { status: 'unknown', reason: 'Job belongs to another run attempt' };
    if (job.conclusion !== 'success' || job.status !== 'completed')
      return {
        status: job.conclusion === 'failure' ? 'fail' : 'unknown',
        reason: `${name} not successful`,
      };
    const sources = evidence.sources.filter((source) => source.jobId === job.id);
    if (sources.length !== 1)
      return { status: 'unknown', reason: `Source receipt missing for ${name}` };
    const source = parseReport(sources[0]!.report);
    if (testedSource !== null && testedSource !== source.sourceSha)
      return { status: 'unknown', reason: 'Jobs tested different source commits' };
    testedSource = source.sourceSha;
    if (
      !/^[a-f0-9]{64}$/.test(sources[0]!.logDigest) ||
      source.producer !== (plan?.full === false ? 'docs-check' : 'source-runner') ||
      assessReport(source, plan?.full === false ? DOCS_CHECKS : ['source-clean', 'source-verify'])
        .exitCode !== 0
    )
      return { status: 'unknown', reason: 'Source receipt incomplete or failed' };
    if (
      plan &&
      (source.sourceSha !== plan.sourceSha ||
        source.testMergeSha !== plan.testMergeSha ||
        (source.testMergeSha !== null && source.baselineSha !== plan.baselineSha))
    )
      return { status: 'unknown', reason: 'Source receipt and CI plan disagree' };
    if (source.candidateSha !== candidate)
      return { status: 'unknown', reason: 'Source receipt has stale candidate' };
    if (main) {
      if (source.sourceSha !== candidate || source.testMergeSha !== null)
        return { status: 'unknown', reason: 'Main source identity mismatch' };
    } else {
      const commit = record(evidence.commits[source.sourceSha]);
      const parents = objects(commit.parents).map((parent) => sha(parent.sha));
      if (
        commit.sha !== source.sourceSha ||
        source.testMergeSha !== source.sourceSha ||
        parents.length !== 2 ||
        parents[1] !== candidate ||
        parents[0] !== source.baselineSha ||
        (!info.merged && parents[0] !== info.base)
      )
        return { status: 'unknown', reason: 'Test merge does not match candidate and tested base' };
    }
  }
  return {
    status: 'pass',
    reason: 'Latest CI and Linux planned receipts match the evaluated revision',
  };
}
export function assessDelivery(
  value: unknown,
  target: DeliveryTarget,
  reviewReceipt: unknown = null,
) {
  if (target !== 'pr' && target !== 'merge') throw new Error('Invalid delivery target');
  const snapshot = parseSnapshot(value);
  const pull = record(snapshot.pull);
  const info = pullIdentity(pull);
  const sourceSha = target === 'merge' && info.merge ? info.merge : info.head;
  const bound: Identity = identity({
    sourceSha,
    candidateSha: info.head,
    baselineSha: null,
    testMergeSha: null,
  });
  const uri = `https://github.com/${snapshot.repository}/pull/${snapshot.number}`;
  const checks: Check[] = [];
  const add = (id: string, status: Check['status'], reason: string, required = true) => {
    checks.push({ id, required, status, reason, evidence: [{ uri, sourceSha }] });
  };
  add(
    'collection',
    snapshot.errors.length ? 'unknown' : 'pass',
    snapshot.errors.length
      ? 'Collection incomplete; inspect bounded error codes'
      : 'All requested pages collected',
  );
  add(
    'snapshot-stable',
    stable(snapshot.pull, snapshot.pullAfter) ? 'pass' : 'unknown',
    'PR head/base/merge/update identity must remain unchanged',
  );
  add(
    'issue-completion-policy',
    issueWordingStatus(pull, reviewReceipt),
    'PR title/body and explicit squash title/body must use non-closing references; completion follows main CI',
  );
  const pr = validateRun(snapshot, snapshot.prRun, false);
  add('pr-ci', pr.status, pr.reason);
  const unresolved = objects(snapshot.threads).some((thread) => thread.isResolved !== true);
  const activeReviews = new Map<string, Record<string, unknown>>();
  for (const review of objects(snapshot.reviews).sort((a, b) => natural(a.id) - natural(b.id))) {
    if (review.state !== 'PENDING' && review.state !== 'COMMENTED')
      activeReviews.set(text(record(review.user).login), review);
  }
  const requested =
    snapshot.reviewDecision === 'CHANGES_REQUESTED' ||
    [...activeReviews.values()].some((review) => review.state === 'CHANGES_REQUESTED');
  add(
    'review-threads',
    unresolved || requested ? 'fail' : 'pass',
    unresolved || requested ? 'Unresolved review findings' : 'All inline review threads resolved',
  );
  add(
    'review-approval',
    requested
      ? 'fail'
      : snapshot.reviewDecision === 'REVIEW_REQUIRED' ||
          (snapshot.reviewDecision === 'APPROVED' &&
            (![...activeReviews.values()].some(
              (review) => review.state === 'APPROVED' && review.commit_id === info.head,
            ) ||
              [...activeReviews.values()].some(
                (review) => review.state === 'APPROVED' && review.commit_id !== info.head,
              )))
        ? 'unknown'
        : 'pass',
    'Repository-required external approval is never replaced by self review',
  );
  add(
    'review-coverage',
    reviewReceiptValid(snapshot, reviewReceipt) ? 'pass' : 'unknown',
    'A candidate- and conversation-bound review receipt must cover every changed path',
  );
  const statuses = objects(snapshot.statuses);
  const latest = new Map<string, Record<string, unknown>>();
  for (const status of [...statuses].sort((a, b) => natural(a.id) - natural(b.id)))
    latest.set(text(status.context), status);
  const adverseStatus = [...latest.values()].some(
    (status) => status.state === 'failure' || status.state === 'error',
  );
  const plannedSkips = new Set<string>();
  if (pr.status === 'pass' && snapshot.prRun?.plan) {
    const plan = parsePlan(snapshot.prRun.plan.value);
    // Source tasks and the corpus observation always run; only these jobs are planned skips.
    const names: readonly string[] = [
      ...(plan.full ? DOCS_JOBS : []),
      ...(plan.load ? [] : [...LOAD_JOBS, LOAD_MATRIX_JOB]),
      ...(plan.ui ? [] : [...UI_JOBS, UI_MATRIX_JOB]),
    ];
    for (const job of objects(snapshot.prRun.jobs))
      if (names.includes(String(job.name)) && job.conclusion === 'skipped')
        plannedSkips.add(String(job.name));
  }
  const adverseCheck = objects(snapshot.checks).some((check) =>
    ['failure', 'timed_out', 'cancelled', 'action_required'].includes(String(check.conclusion)),
  );
  add(
    'additional-checks',
    adverseStatus || adverseCheck
      ? 'fail'
      : [...latest.values()].some((status) => status.state !== 'success') ||
          objects(snapshot.checks).some(
            (check) =>
              !(
                check.conclusion === 'skipped' &&
                (check.name === 'Release' || plannedSkips.has(String(check.name)))
              ) &&
              (check.status !== 'completed' ||
                !['success', 'neutral'].includes(String(check.conclusion))),
          )
        ? 'unknown'
        : 'pass',
    'Other observed pending, failed or unexpected skipped statuses/checks must not be ignored',
  );
  if (target === 'merge') {
    add(
      'main-merge',
      pull.merged === true && record(pull.base).ref === 'main' ? 'pass' : 'unknown',
      'Actual merge into main is required',
    );
    const main = validateRun(snapshot, snapshot.mainRun, true);
    add('main-ci', main.status, main.reason);
    const release = snapshot.mainRun
      ? objects(snapshot.mainRun.jobs).find((job) => job.name === 'Release')
      : undefined;
    add(
      'release',
      release?.conclusion === 'success'
        ? 'pass'
        : release?.conclusion === 'failure'
          ? 'fail'
          : 'unknown',
      'Release evaluation is separate; absence of a tag does not imply failure',
      false,
    );
  }
  const report: Report = {
    ...bound,
    schemaVersion: 1,
    producer: 'github-delivery',
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
    checks,
  };
  return assessReport(
    report,
    checks.filter((check) => check.required).map((check) => check.id),
  );
}
