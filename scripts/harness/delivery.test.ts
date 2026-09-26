import assert from 'node:assert/strict';
import { describe, it } from 'vite-plus/test';
import { assessDelivery, conversationDigest, parseSnapshot, VERIFY_JOBS } from './delivery.ts';
import type { DeliverySnapshot, RunEvidence } from './delivery.ts';
import type { Report } from './report.ts';
import { assessGate } from '../ci/gate.ts';
import { loadReceipts } from './test-support/load.ts';
import { corpusEvidence } from './test-support/corpus.ts';
import { classify } from '../ci/plan.ts';
import { SECURITY_CHECKS } from '../security/evidence.ts';
import { UI_CHECKS } from '../../e2e/contract.ts';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const TESTED = 'c'.repeat(40);
const MERGED = 'd'.repeat(40);
const AT = '2026-01-01T00:00:00Z';
export function sourceReport(main = false): Report {
  const sourceSha = main ? MERGED : TESTED;
  return {
    schemaVersion: 1,
    producer: 'source-runner',
    sourceSha,
    candidateSha: main ? MERGED : HEAD,
    baselineSha: main ? null : BASE,
    testMergeSha: main ? null : TESTED,
    startedAt: AT,
    finishedAt: AT,
    checks: ['source-clean', 'source-verify'].map((id) => ({
      id,
      required: true,
      status: 'pass',
      reason: 'fixture',
      evidence: [{ uri: '.generated/harness/source/report.json', sourceSha }],
    })),
  };
}
function evidence(main = false): RunEvidence {
  const run = {
    id: main ? 20 : 10,
    head_sha: main ? MERGED : HEAD,
    run_attempt: 1,
    event: main ? 'push' : 'pull_request',
    head_branch: main ? 'main' : 'feature',
    path: '.github/workflows/ci.yml',
    status: 'completed',
    conclusion: 'success',
  };
  return {
    before: structuredClone(run),
    after: structuredClone(run),
    jobs: VERIFY_JOBS.map((name, index) => ({
      id: index + 1,
      name,
      run_id: run.id,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
    })),
    sources: VERIFY_JOBS.map((_, index) => ({
      jobId: index + 1,
      report: sourceReport(main),
      logDigest: 'e'.repeat(64),
    })),
    commits: { [TESTED]: { sha: TESTED, parents: [{ sha: BASE }, { sha: HEAD }] } },
  };
}
export function fixture(merged = false): DeliverySnapshot {
  const pull = {
    number: 13,
    title: 'feat: tested change',
    body: 'Refs #9',
    updated_at: AT,
    state: merged ? 'closed' : 'open',
    merged,
    merge_commit_sha: merged ? MERGED : TESTED,
    head: { sha: HEAD, ref: 'feature' },
    base: { sha: BASE, ref: 'main', repo: { full_name: 'owner/repo' } },
    changed_files: 1,
  };
  const prRun = evidence();
  const mainRun = merged ? evidence(true) : null;
  return {
    schemaVersion: 1,
    repository: 'owner/repo',
    number: 13,
    startedAt: AT,
    finishedAt: AT,
    pull: structuredClone(pull),
    pullAfter: structuredClone(pull),
    comments: [],
    reviews: [],
    threads: [],
    files: [{ filename: 'scripts/example.ts' }],
    reviewDecision: null,
    prRuns: [structuredClone(prRun.before)],
    prRunsAfter: [structuredClone(prRun.before)],
    mainRuns: mainRun ? [structuredClone(mainRun.before)] : [],
    mainRunsAfter: mainRun ? [structuredClone(mainRun.before)] : [],
    prRun,
    mainRun,
    checks: [],
    statuses: [],
    errors: [],
  };
}
function receipt(snapshot: DeliverySnapshot) {
  return {
    candidateSha: HEAD,
    conversationDigest: conversationDigest(snapshot),
    reviewedPaths: ['scripts/example.ts'],
    completedAt: AT,
    method: 'self',
    summary: 'Reviewed fixture paths and complete conversation.',
    unresolvedFindings: 0,
    squashTitle: 'feat: tested change',
    squashBody: 'Refs #9',
  };
}
function change(obj: unknown, key: string, value: unknown) {
  (obj as Record<string, unknown>)[key] = value;
}
describe('delivery evidence', () => {
  it('blocks automatic Issue closure even inside explanatory prose', () => {
    for (const body of [
      'The declaration only closes #9 after successful main CI.',
      'CLOSES: #9',
      'Fixed owner/repo#9',
      'Resolves https://github.com/owner/repo/issues/9',
    ]) {
      const value = fixture();
      change(value.pull, 'body', body);
      change(value.pullAfter, 'body', body);
      assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 1);
    }
    for (const body of ['Refs #9', 'Completion follows main CI for Issue #9.', null]) {
      const value = fixture();
      change(value.pull, 'body', body);
      change(value.pullAfter, 'body', body);
      assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 0);
    }
    const missing = fixture();
    change(missing.pull, 'body', undefined);
    change(missing.pullAfter, 'body', undefined);
    assert.equal(assessDelivery(missing, 'pr', receipt(missing)).exitCode, 2);
  });
  it('binds PR wording to review receipts and snapshot stability', () => {
    for (const field of ['title', 'body']) {
      const value = fixture();
      const reviewed = receipt(value);
      change(value.pullAfter, field, 'Revised wording');
      assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 2);
      change(value.pull, field, 'Revised wording');
      assert.equal(assessDelivery(value, 'pr', reviewed).exitCode, 2);
      assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 0);
    }
  });
  it('checks PR titles and requires explicit safe final squash wording', () => {
    for (const field of ['title', 'squashTitle', 'squashBody']) {
      for (const [wording, exitCode] of [
        ['fix: prevent regression (Fixes #9)', 1],
        [undefined, 2],
      ] as const) {
        const value = fixture();
        const reviewed = receipt(value);
        change(field === 'title' ? value.pull : reviewed, field, wording);
        if (field === 'title') change(value.pullAfter, field, wording);
        assert.equal(assessDelivery(value, 'pr', reviewed).exitCode, exitCode);
      }
    }
  });
  it('separates collection, review coverage and PR completion', () => {
    const value = fixture();
    assert.equal(assessDelivery(value, 'pr').exitCode, 2);
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 0);
    assert.equal(assessDelivery(value, 'merge', receipt(value)).exitCode, 2);
  });
  it('requires main push CI for the real merge and does not infer release from tags', () => {
    const value = fixture(true);
    const result = assessDelivery(value, 'merge', receipt(value));
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.checks.find((check) => check.id === 'release')?.status, 'unknown');
    change(value.mainRun!.after, 'status', 'in_progress');
    assert.equal(assessDelivery(value, 'merge', receipt(value)).exitCode, 2);
    change(value.mainRun!.after, 'conclusion', 'failure');
    assert.equal(assessDelivery(value, 'merge', receipt(value)).exitCode, 1);
  });
  it('rejects a newer run or changed retry instead of reusing old green evidence', () => {
    for (const field of ['id', 'run_attempt']) {
      const value = fixture();
      change(value.prRunsAfter[0], field, 99);
      assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 2);
    }
  });
  it('requires Linux, correct attempt and the same actual test source', () => {
    const value = fixture();
    value.prRun!.sources.pop();
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 2);
    const retry = fixture();
    change(retry.prRun!.jobs[0], 'run_attempt', 2);
    assert.equal(assessDelivery(retry, 'pr', receipt(retry)).exitCode, 2);
    const other = fixture();
    change(other.prRun!.sources[0]!.report, 'candidateSha', BASE);
    assert.equal(assessDelivery(other, 'pr', receipt(other)).exitCode, 2);
  });
  it('rejects unrelated test-merge parents and stale base/head', () => {
    const value = fixture();
    change(value.prRun!.commits[TESTED], 'parents', [{ sha: HEAD }, { sha: BASE }]);
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 2);
    const stale = fixture();
    change((stale.pull as { base: unknown }).base, 'sha', MERGED);
    assert.equal(assessDelivery(stale, 'pr', receipt(stale)).exitCode, 2);
    const racing = fixture();
    change((racing.pullAfter as { head: unknown }).head, 'sha', MERGED);
    assert.equal(assessDelivery(racing, 'pr', receipt(racing)).exitCode, 2);
  });
  it('keeps unresolved/outdated threads and required approval blocking', () => {
    const value = fixture();
    value.threads.push({ id: 'thread', isResolved: false, isOutdated: true, comments: [] });
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 1);
    value.threads = [];
    value.reviewDecision = 'REVIEW_REQUIRED';
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 2);
    value.reviewDecision = 'CHANGES_REQUESTED';
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 1);
  });
  it('does not erase a requested change merely because branch protection is absent', () => {
    const value = fixture();
    value.reviews.push({ id: 1, state: 'CHANGES_REQUESTED', user: { login: 'reviewer' } });
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 1);
    value.reviews.push({ id: 2, state: 'APPROVED', user: { login: 'reviewer' } });
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 0);
  });
  it('invalidates receipts on conversation or changed path changes', () => {
    const value = fixture();
    const old = receipt(value);
    value.comments.push({ id: 1, body: 'new finding' });
    assert.equal(assessDelivery(value, 'pr', old).exitCode, 2);
    assert.equal(assessDelivery(value, 'pr', { ...receipt(value), reviewedPaths: [] }).exitCode, 2);
  });
  it('missing collection and unexpected failed checks cannot pass', () => {
    const value = fixture();
    value.errors.push('incomplete:review-threads');
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 2);
    value.errors = [];
    value.checks.push({ conclusion: 'failure' });
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 1);
  });
  it('uses the latest status for each context and rejects malformed snapshots', () => {
    const value = fixture();
    value.statuses.push(
      { id: 1, context: 'lint', state: 'failure' },
      { id: 2, context: 'lint', state: 'success' },
    );
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 0);
    assert.throws(() => parseSnapshot({ ...value, comments: undefined }));
    assert.throws(() => parseSnapshot({ ...value, repository: '../../elsewhere' }));
  });
  it('keeps other pending checks incomplete and reuses only unchanged review inputs', () => {
    const value = fixture();
    const reviewed = receipt(value);
    value.startedAt = '2026-01-02T00:00:00Z';
    value.finishedAt = value.startedAt;
    assert.equal(assessDelivery(value, 'pr', reviewed).exitCode, 0);
    value.checks.push({ name: 'Security', status: 'in_progress', conclusion: null });
    assert.equal(assessDelivery(value, 'pr', reviewed).exitCode, 2);
  });
  it('does not accept an old-head approval as current external approval', () => {
    const value = fixture();
    value.reviewDecision = 'APPROVED';
    value.reviews.push({ id: 1, state: 'APPROVED', user: { login: 'reviewer' }, commit_id: BASE });
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 2);
    change(value.reviews[0], 'commit_id', HEAD);
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 0);
  });
});

function plannedRun(run: RunEvidence, full: boolean, main = false) {
  const plan = classify(sourceReport(main), main ? 'push' : 'pull_request', [
    full ? 'apps/web/source.ts' : 'README.md',
  ]);
  const sha = main ? MERGED : TESTED;
  const security = sourceReport(main);
  security.producer = 'security-evidence';
  security.checks = SECURITY_CHECKS.map((id) => ({
    id,
    required: true,
    status: 'pass',
    reason: 'fixture',
    evidence: [{ uri: '.generated/harness/ci/security.json', sourceSha: sha }],
  }));
  const reports: Record<string, Report> = { security };
  if (plan.ui)
    reports.ui = {
      ...sourceReport(main),
      producer: 'ui-runner',
      checks: UI_CHECKS.map((id) => ({
        ...sourceReport(main).checks[0]!,
        id,
      })),
    };
  for (const [index, os] of ['ubuntu-latest'].entries()) {
    const report = sourceReport(main);
    if (!full) {
      report.producer = 'docs-check';
      report.checks[0]!.id = 'docs:diff';
      report.checks[1]!.id = 'docs:links';
      report.checks.push({ ...report.checks[1]!, id: 'docs:context' });
      change(run.jobs[index], 'name', `Docs (${os})`);
    }
    run.sources[index]!.report = report;
    reports[full ? os : `docs-${os}`] = report;
  }
  const results = {
    changes: 'success',
    security: 'success',
    'dependency-policy': 'success',
    tasks: 'success',
    corpus: 'success',
    load: plan.load ? 'success' : 'skipped',
    docs: full ? 'skipped' : 'success',
    ui: plan.ui ? 'success' : 'skipped',
  };
  const id = main ? 20 : 10;
  for (const [index, name] of ['changes', 'ci-gate'].entries())
    run.jobs.push({
      id: 3 + index,
      name,
      run_id: id,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
    });
  run.plan = { jobId: 3, value: plan, logDigest: 'e'.repeat(64) };
  run.gate = {
    jobId: 4,
    report: assessGate(plan, results, { ...reports, ...loadReceipts(plan) }, corpusEvidence(plan))
      .report,
    logDigest: 'e'.repeat(64),
  };
  const skipped = full ? 'Docs (ubuntu-latest)' : 'Verify (ubuntu-latest)';
  run.jobs.push({
    id: 5,
    name: skipped,
    run_id: id,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'skipped',
  });
  return skipped;
}
function plannedFixture(full: boolean) {
  const value = fixture();
  const skipped = plannedRun(value.prRun!, full);
  value.checks.push({ id: 5, name: skipped, status: 'completed', conclusion: 'skipped' });
  return value;
}
describe('delivery with differential CI', () => {
  it('refuses missing context evidence even with a successful docs aggregate', () => {
    const value = plannedFixture(false);
    const report = value.prRun!.sources[0]!.report as Report;
    report.checks = report.checks.filter((check) => check.id !== 'docs:context');
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 2);
  });
  it('accepts only observed skips authorized by the exact plan', () => {
    const skip = (value: DeliverySnapshot, name: string) => {
      value.prRun!.jobs.push({
        id: 20,
        name,
        run_id: 10,
        run_attempt: 1,
        status: 'completed',
        conclusion: 'skipped',
      });
      value.checks.push({ id: 20, name, status: 'completed', conclusion: 'skipped' });
      return assessDelivery(value, 'pr', receipt(value)).exitCode;
    };
    // PRs never wait for main-only browser, paired load or CodeQL work.
    for (const name of [
      'UI (Linux Chromium/WebKit)',
      'Paired load (ubuntu-latest, ${{ matrix.shard }}/3)',
    ])
      for (const full of [true, false]) assert.equal(skip(plannedFixture(full), name), 0);
    // Source tasks and the corpus observation run for every PR, including wording-only ones.
    for (const name of ['Source (${{ matrix.task }})', 'Corpus (ubuntu-latest)'])
      for (const full of [true, false]) assert.equal(skip(plannedFixture(full), name), 2);
  });
  it('accepts full and wording plans only with Linux receipts and the aggregate', () => {
    for (const full of [true, false]) {
      const value = plannedFixture(full);
      assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 0);
      value.prRun!.sources.pop();
      assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 2);
    }
  });
  it('rejects deleted H4 gate entries even when all jobs succeeded', () => {
    const ids = ['ci-evidence:security', ...SECURITY_CHECKS];
    for (const full of [true, false]) {
      for (const removed of [...ids.map((id) => [id]), ids]) {
        const value = plannedFixture(full);
        const gate = value.prRun!.gate!.report as Report;
        gate.checks = gate.checks.filter((check) => !removed.includes(check.id));
        assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 2);
      }
    }
  });
  it('requires corpus and the complete paired load receipt even when CI claims success', () => {
    const value = plannedFixture(true);
    const gate = value.prRun!.gate!.report as Report;
    gate.checks = gate.checks.filter((check) => check.id !== 'corpus:artifacts');
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 2);
    const merged = () => {
      const result = fixture(true);
      plannedRun(result.prRun!, true);
      plannedRun(result.mainRun!, true, true);
      return result;
    };
    assert.equal(assessDelivery(merged(), 'merge', receipt(merged())).exitCode, 0);
    for (const id of [
      'corpus:artifacts',
      'ci-evidence:load-pair',
      'ci-evidence:ui',
      'security:codeql-severity',
    ]) {
      const main = merged();
      const report = main.mainRun!.gate!.report as Report;
      report.checks = report.checks.filter((check) => check.id !== id);
      assert.equal(assessDelivery(main, 'merge', receipt(main)).exitCode, 2, id);
    }
  });
  it('rejects missing, stale, failing and foreign-attempt plan/gate receipts', () => {
    for (const mutate of [
      (v: DeliverySnapshot) => {
        delete v.prRun!.plan;
      },
      (v: DeliverySnapshot) => {
        delete v.prRun!.gate;
      },
      (v: DeliverySnapshot) => {
        change(v.prRun!.plan!.value, 'candidateSha', BASE);
      },
      (v: DeliverySnapshot) => {
        change(v.prRun!.gate!.report, 'candidateSha', BASE);
      },
      (v: DeliverySnapshot) => {
        change(
          v.prRun!.jobs.find((job) => (job as { name: string }).name === 'ci-gate'),
          'run_attempt',
          2,
        );
      },
      (v: DeliverySnapshot) => {
        change(v.prRun!.gate!, 'logDigest', 'invalid');
      },
      (v: DeliverySnapshot) => {
        change((v.prRun!.gate!.report as Report).checks[0], 'status', 'fail');
      },
      (v: DeliverySnapshot) => {
        const gate = v.prRun!.gate!.report as Report;
        change(
          gate.checks.find((check) => check.id === 'security:secret-scan'),
          'status',
          'unknown',
        );
      },
    ]) {
      const value = plannedFixture(false);
      mutate(value);
      assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 2);
    }
  });
  it('never allows an unrelated skipped check or a main docs-only plan', () => {
    const value = plannedFixture(false);
    value.checks.push({ name: 'Security', status: 'completed', conclusion: 'skipped' });
    assert.equal(assessDelivery(value, 'pr', receipt(value)).exitCode, 2);
    const merged = fixture(true);
    merged.mainRun = plannedFixture(false).prRun;
    assert.equal(assessDelivery(merged, 'merge', receipt(merged)).exitCode, 2);
  });
});
