import assert from 'node:assert/strict';
import { describe, it } from 'vite-plus/test';
import { assessReport, parseReport, timestamp } from './report.ts';
import type { Report } from './report.ts';
const sourceSha = 'a'.repeat(40);
function example(): Report {
  return { schemaVersion: 1, producer: 'fixture', sourceSha, candidateSha: sourceSha,
    baselineSha: null, testMergeSha: null, startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:01Z', checks: [
      { id: 'test', required: true, status: 'pass', reason: 'assertion passed',
        evidence: [{ uri: '.generated/harness/test/log.txt', sourceSha }] },
    ] };
}
describe('bound evidence reports', () => {
  it('passes only a covered required contract', () => {
    assert.equal(assessReport(example(), ['test']).exitCode, 0);
    assert.equal(assessReport(example(), ['test', 'missing']).exitCode, 2);
    assert.throws(() => assessReport(example(), []));
  });
  it('keeps failure, unknown and required skip distinct', () => {
    for (const status of ['fail', 'unknown', 'skipped'] as const) {
      const value = example();
      value.checks[0]!.status = status;
      assert.equal(assessReport(value, ['test']).exitCode, status === 'fail' ? 1 : 2);
    }
  });
  it('does not trust a pass with no evidence or a stale source', () => {
    const value = example();
    value.checks[0]!.evidence[0]!.sourceSha = 'b'.repeat(40);
    assert.equal(assessReport(value, ['test']).exitCode, 2);
    value.checks[0]!.evidence = [];
    assert.equal(assessReport(value, ['test']).exitCode, 2);
  });
  it('rejects duplicate IDs, missing identity and reversed intervals', () => {
    const value = example();
    value.checks.push(value.checks[0]!);
    assert.throws(() => parseReport(value));
    assert.throws(() => parseReport({ ...example(), sourceSha: 'short' }));
    assert.throws(() => parseReport({ ...example(), baselineSha: undefined }));
    assert.throws(() => parseReport({ ...example(), finishedAt: '2025-01-01T00:00:00Z' }));
    assert.throws(() => parseReport({ ...example(), testMergeSha: 'b'.repeat(40) }));
  });
  it('rejects unsafe URI forms and impossible timestamps', () => {
    for (const uri of ['../secret', '/tmp/log', 'https://user:password@example.org/log',
      'javascript:alert(1)', 'a//b', 'a/./b', 'C:\\secret']) {
      const value = example();
      value.checks[0]!.evidence[0]!.uri = uri;
      assert.throws(() => parseReport(value));
    }
    assert.throws(() => timestamp('2026-02-30T00:00:00Z'));
    assert.equal(timestamp('2026-01-01T09:00:00+09:00'), '2026-01-01T00:00:00.000Z');
  });
});
