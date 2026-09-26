import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessReport } from '../harness/report.ts';
import type { Identity } from '../harness/report.ts';
import { assessSecurityEvidence, SECURITY_CHECKS, securityInputs } from './evidence.ts';
import { validatorOutcome } from './validator.ts';
import { classify } from '../ci/plan.ts';

const info: Identity = {
  sourceSha: 'a'.repeat(40),
  candidateSha: 'b'.repeat(40),
  baselineSha: 'c'.repeat(40),
  testMergeSha: 'a'.repeat(40),
};
const run = { runId: '123', runAttempt: '2' };
const at = '2026-09-23T00:00:00.000Z';
function fixtures(target = info): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    securityInputs(run).map(({ key, checkId }) => [
      key,
      {
        schemaVersion: 1,
        producer: 'fantasy-security-h4',
        checkId,
        sourceSha: target.sourceSha,
        prHeadSha: target.testMergeSha ? target.candidateSha : null,
        baselineSha: target.baselineSha,
        ...run,
        completedAt: at,
        status: 'pass',
        reason: 'VERIFIED_FIXTURE',
        counts: {
          scenarios: 4,
          detected: 0,
          excepted: 0,
          blocking: 0,
          runs: 1,
          rules: 30,
          findings: 0,
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
          checks: 6,
          validators: 1,
        },
      },
    ]),
  );
}

await test('six receipts bind to the common report and exact artifact paths', () => {
  const result = assessSecurityEvidence(info, run, fixtures(), at);
  assert.equal(result.exitCode, 0);
  assert.equal(assessReport(result.report, SECURITY_CHECKS).exitCode, 0);
  assert.equal(result.report.producer, 'security-evidence');
  assert.equal(result.report.checks.length, 6);
  for (const check of result.report.checks) {
    assert.equal(check.required, true);
    assert.ok(check.evidence[0]?.uri.includes('-123-2/'));
  }
});

await test('CodeQL scope exclusion requires an exact independently validated wording-only plan', () => {
  const receipts = fixtures();
  receipts['codeql-severity'] = {
    ...receipts['codeql-severity'],
    reason: 'WORDING_ONLY_NO_CODE_CHANGE',
    counts: { plannedSkip: 1 },
  };
  const docs = classify(info, 'pull_request', ['README.md']);
  assert.equal(assessSecurityEvidence(info, run, receipts, at, docs).exitCode, 0);
  for (const path of ['apps/web/src/App.tsx', 'scripts/security/codeql.ts', 'pnpm-lock.yaml'])
    assert.equal(
      assessSecurityEvidence(info, run, receipts, at, classify(info, 'pull_request', [path]))
        .exitCode,
      2,
    );
  assert.equal(assessSecurityEvidence(info, run, receipts, at).exitCode, 2);
  assert.throws(() =>
    assessSecurityEvidence(info, run, receipts, at, { ...docs, paths: ['apps/api/src/main.ts'] }),
  );
  // Code PRs use the fast lane; the receipt must name it and main/manual runs still analyze.
  const fastLane = {
    ...receipts,
    'codeql-severity': { ...receipts['codeql-severity'], reason: 'PR_FAST_LANE_CODEQL_ON_MAIN' },
  };
  const code = classify(info, 'pull_request', ['apps/api/src/main.ts']);
  assert.equal(assessSecurityEvidence(info, run, fastLane, at, code).exitCode, 0);
  assert.equal(assessSecurityEvidence(info, run, fastLane, at, docs).exitCode, 2);
  const main = { ...info, candidateSha: info.sourceSha, testMergeSha: null };
  for (const event of ['push', 'workflow_dispatch', 'schedule'])
    assert.equal(
      assessSecurityEvidence(main, run, fixtures(main), at, {
        ...classify(main, event, ['README.md']),
      }).exitCode,
      0,
    );
  const mainFastLane = fixtures(main);
  mainFastLane['codeql-severity'] = { ...fastLane['codeql-severity'], prHeadSha: null };
  assert.equal(
    assessSecurityEvidence(main, run, mainFastLane, at, classify(main, 'push', ['a.ts'])).exitCode,
    2,
  );
  assert.throws(() =>
    assessSecurityEvidence(info, run, receipts, at, { ...docs, sourceSha: 'd'.repeat(40) }),
  );
});

await test('main and manual runs never invent PR identities', () => {
  for (const baselineSha of [info.baselineSha, null]) {
    const main = { ...info, candidateSha: info.sourceSha, testMergeSha: null, baselineSha };
    assert.equal(assessSecurityEvidence(main, run, fixtures(main), at).exitCode, 0);
  }
});

await test('missing, skipped, corrupt and unsuccessful receipts block acceptance', () => {
  for (const { key } of securityInputs(run)) {
    for (const value of [null, undefined, [], 'invalid', {}, { status: 'pass' }]) {
      assert.equal(
        assessSecurityEvidence(info, run, { ...fixtures(), [key]: value }, at).exitCode,
        2,
      );
    }
    for (const status of ['fail', 'unknown', 'skipped', 'cancelled', 'success', '']) {
      const receipts = fixtures();
      receipts[key] = { ...receipts[key], status };
      assert.equal(
        assessSecurityEvidence(info, run, receipts, at).exitCode,
        status === 'fail' ? 1 : 2,
      );
    }
  }
});

await test('rejects incorrect receipt identities and invalid timestamps', () => {
  for (const [field, value] of [
    ['schemaVersion', 2],
    ['producer', 'other'],
    ['checkId', 'secret-canary'],
    ['sourceSha', 'd'.repeat(40)],
    ['prHeadSha', null],
    ['baselineSha', 'd'.repeat(40)],
    ['runId', '124'],
    ['runAttempt', '1'],
    ['completedAt', '2026-02-30T00:00:00Z'],
    ['completedAt', '2026-09-24T00:00:00Z'],
    ['reason', 'Do not publish arbitrary text'],
  ]) {
    const receipts = fixtures();
    receipts['secret-scan'] = { ...receipts['secret-scan'], [field as string]: value };
    assert.equal(assessSecurityEvidence(info, run, receipts, at).exitCode, 2, String(field));
  }
});

await test('rejects invalid counts and inconsistent success claims', () => {
  for (const [key, counts] of [
    ['secret-canary', { scenarios: 0 }],
    ['secret-scan', { detected: 1, excepted: 0, blocking: 1 }],
    ['secret-scan', { blocking: 0 }],
    ['codeql-severity', { runs: 1, rules: 0, findings: 0, blocking: 0 }],
    ['dependency-audit', { high: 0, critical: 0 }],
    ['dependency-audit', { info: 0, low: 0, moderate: 0, high: 1, critical: 0 }],
    ['renovate-configuration', { validators: 0 }],
    ['toolchain-ubuntu-latest', { checks: 0 }],
    ['secret-scan', { detected: -1, excepted: -1, blocking: 0 }],
    ['secret-scan', { detected: 0.5, excepted: 0.5, blocking: 0 }],
    ['secret-scan', { detected: '0', excepted: '0', blocking: 0 }],
  ] as const) {
    const receipts: Record<string, unknown> = fixtures();
    receipts[key] = { ...fixtures()[key], counts };
    assert.equal(assessSecurityEvidence(info, run, receipts, at).exitCode, 2, key);
  }
});

await test('never forwards raw errors or arbitrary receipt strings', () => {
  const privateText = 'PRIVATE_FIXTURE_TEXT_MUST_NOT_LEAVE_INPUT';
  const receipts = fixtures();
  receipts['secret-scan'] = { ...receipts['secret-scan'], reason: privateText + '\nraw output' };
  const output = JSON.stringify(assessSecurityEvidence(info, run, receipts, at));
  assert.ok(!output.includes(privateText));
});

await test('unsafe run identifiers cannot select other artifacts', () => {
  for (const value of ['', '0', '../123', '1/2', '1.0', 'NaN']) {
    assert.throws(() => securityInputs({ ...run, runId: value }));
    assert.throws(() => securityInputs({ ...run, runAttempt: value }));
  }
});

await test('validator failure and non-execution never produce a passing receipt', () => {
  assert.equal(validatorOutcome('success').status, 'pass');
  assert.equal(validatorOutcome('failure').status, 'fail');
  for (const value of ['skipped', 'cancelled', '', undefined, null, true, 'pass'])
    assert.equal(validatorOutcome(value).status, 'unknown');
});
