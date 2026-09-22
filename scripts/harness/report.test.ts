import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessReport, evidenceUri, exitCode, parseReport, sha, timestamp } from './report.ts';
import type { HarnessReport } from './report.ts';

const sourceSha = 'a'.repeat(40);
const requirements = [{ id: 'verify', scope: 'source' as const }];
function sample(): HarnessReport {
  return {
    schemaVersion: 1,
    producer: 'test-fixture',
    runId: 'test',
    sourceSha,
    candidateSha: sourceSha,
    baselineSha: null,
    startedAt: '2026-09-22T00:00:00Z',
    finishedAt: '2026-09-22T00:00:01Z',
    checks: [{ id: 'verify', scope: 'source', required: true, status: 'pass', reason: 'exit 0', evidence: [{ uri: '.generated/harness/run/log.txt', sourceSha }] }],
  };
}

test('valid evidence passes and exit codes preserve incomplete versus failed', () => {
  assert.equal(assessReport(sample(), requirements).status, 'pass');
  assert.deepEqual(['pass', 'fail', 'unknown', 'skipped'].map((status) => exitCode(status as 'pass' | 'fail' | 'unknown' | 'skipped')), [0, 1, 2, 2]);
});
test('missing requirements cannot be waived by a caller-authored report', () => {
  const report = sample();
  report.checks = report.checks.map((check) => ({ ...check, id: 'unrelated', required: false }));
  const result = assessReport(report, requirements);
  assert.equal(result.status, 'unknown');
  assert.equal(result.checks.find((check) => check.id === 'verify')?.required, true);
});
test('failure and required skip cannot pass', () => {
  for (const status of ['fail', 'unknown', 'skipped'] as const) {
    const report = sample();
    report.checks = report.checks.map((check) => ({ ...check, status, required: false }));
    assert.equal(assessReport(report, requirements).status, status === 'fail' ? 'fail' : 'unknown');
  }
});
test('stale, absent or wrong-scope evidence remains incomplete', () => {
  const report = sample();
  report.checks = report.checks.map((check) => ({ ...check, evidence: [{ uri: 'log.txt', sourceSha: 'b'.repeat(40) }] }));
  assert.equal(assessReport(report, requirements).status, 'unknown');
  report.checks = report.checks.map((check) => ({ ...check, evidence: [] }));
  assert.equal(assessReport(report, requirements).status, 'unknown');
  assert.equal(assessReport(sample(), [{ id: 'verify', scope: 'merge' }]).status, 'unknown');
});
test('duplicate checks, empty policy, incomplete schema and impossible dates are rejected', () => {
  const report = sample();
  report.checks = [...report.checks, ...report.checks];
  assert.throws(() => parseReport(report));
  assert.throws(() => assessReport(sample(), []));
  assert.throws(() => parseReport({ ...sample(), baselineSha: undefined }));
  assert.throws(() => parseReport({ ...sample(), startedAt: '2027-01-01T00:00:00Z' }));
  for (const value of ['2026-02-30T00:00:00Z', '2026-09-22', '2026-09-22T25:00:00Z']) assert.throws(() => timestamp(value));
  assert.equal(timestamp('2026-09-22T09:00:00+09:00'), '2026-09-22T00:00:00.000Z');
});
test('SHA and evidence validation rejects traversal, credentials and executable URLs', () => {
  for (const value of ['main', 'a'.repeat(7), '0'.repeat(40)]) assert.throws(() => sha(value));
  for (const uri of ['../file', '/etc/passwd', 'a/../b', 'a//b', 'C:\\file', 'file:///tmp/x', 'javascript:alert(1)', 'https://user:password@example.com/log', 'https://example.com/log?token=value']) assert.throws(() => evidenceUri(uri));
  assert.equal(evidenceUri('https://github.com/owner/repo/actions/runs/123'), 'https://github.com/owner/repo/actions/runs/123');
});
