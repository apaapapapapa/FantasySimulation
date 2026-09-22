import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest, exitCode } from './common.ts';
import { exceptions, parseFindings } from './secrets.ts';

const now = Date.parse('2026-09-22T00:00:00Z');
const exception = {
  fingerprintSha256: 'a'.repeat(64),
  reason: 'Confirmed synthetic test fixture, not an issued credential.',
  reviewer: 'maintainer',
  reviewedAt: '2026-09-21T00:00:00Z',
  expiresAt: '2026-09-28T00:00:00Z',
};

await test('missing and failed checks cannot use the success exit code', () => {
  assert.equal(exitCode('pass'), 0);
  assert.equal(exitCode('fail'), 1);
  assert.equal(exitCode('unknown'), 2);
});

await test('secret exceptions require a single fingerprint and a time-limited review', () => {
  assert.equal(exceptions([], now).size, 0);
  assert.equal(exceptions([exception], now).size, 1);
  for (const invalid of [
    { ...exception, fingerprintSha256: 'docs/**' },
    { ...exception, reviewer: '' },
    { ...exception, reason: '' },
    { ...exception, expiresAt: '2026-09-22T00:00:00Z' },
    { ...exception, expiresAt: '2027-01-01T00:00:00Z' },
    { ...exception, reviewedAt: '2026-09-23T00:00:00Z' },
    { ...exception, reviewedAt: 'invalid' },
  ]) {
    assert.throws(() => exceptions([invalid], now));
  }
  assert.throws(() => exceptions([exception, exception], now));
  assert.throws(() => exceptions({}, now));
});

await test('secret output contains no source text or credential value', () => {
  const synthetic = ['not', 'a', 'credential'].join('-');
  const findings = parseFindings([
    {
      RuleID: 'test-rule',
      File: `docs/${synthetic}.md`,
      StartLine: 7,
      Fingerprint: `commit:docs/${synthetic}.md:test-rule:7`,
      Line: synthetic,
      Match: synthetic,
      Secret: synthetic,
      Author: synthetic,
    },
  ]);
  assert.equal(findings[0]?.line, 7);
  assert.equal(findings[0]?.locationId, digest(`docs/${synthetic}.md`));
  assert.ok(!JSON.stringify(findings).includes(synthetic));
  assert.throws(() => parseFindings({}));
  assert.throws(() => parseFindings([{}]));
});
