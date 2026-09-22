import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditOutcome } from './audit.ts';
import { codeqlOutcome } from './codeql.ts';

const cleanAudit = {
  advisories: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
};

function sarif(score: string, results = true) {
  return {
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'CodeQL',
            rules: [{ id: 'js/test', properties: { 'security-severity': score } }],
          },
        },
        invocations: [{ executionSuccessful: true }],
        results: results ? [{ ruleId: 'js/test', baselineState: 'unchanged' }] : [],
      },
    ],
  };
}

await test('audit success requires a complete inventory and the matching exit code', () => {
  assert.equal(auditOutcome(cleanAudit, 0).status, 'pass');
  assert.throws(() => auditOutcome(cleanAudit, 1));
  assert.throws(() => auditOutcome(cleanAudit, null));
  assert.throws(() => auditOutcome(cleanAudit, 2));
  assert.throws(() => auditOutcome({ metadata: cleanAudit.metadata }, 0));
});

await test('audit offline, invalid and incomplete reports cannot pass', () => {
  for (const value of [null, {}, { error: 'offline' }, { metadata: {} }]) {
    assert.throws(() => auditOutcome(value, 0));
  }
  assert.throws(() => auditOutcome({ ...cleanAudit, error: 'service unavailable' }, 0));
});

await test('audit blocks high and critical in development and transitive inventory', () => {
  for (const severity of ['high', 'critical']) {
    const value = structuredClone(cleanAudit);
    Object.assign(value.metadata.vulnerabilities, { [severity]: 1 });
    assert.equal(auditOutcome(value, 1).status, 'fail');
    assert.throws(() => auditOutcome(value, 0));
  }
});

await test('lower severity findings remain visible without blocking the high threshold', () => {
  const value = structuredClone(cleanAudit);
  value.metadata.vulnerabilities.moderate = 2;
  assert.equal(auditOutcome(value, 0).counts.moderate, 2);
});

await test('CodeQL applies the numerical high/critical threshold to existing findings too', () => {
  assert.equal(codeqlOutcome(sarif('6.9')).status, 'pass');
  assert.equal(codeqlOutcome(sarif('7.0')).status, 'fail');
  assert.equal(codeqlOutcome(sarif('9.8')).status, 'fail');
  assert.equal(codeqlOutcome(sarif('9.8', false)).counts.findings, 0);
});

await test('successful analysis does not make a suppressed high finding pass', () => {
  const value = sarif('8.0');
  Object.assign(value.runs[0]?.results[0] ?? {}, { suppressions: [{ status: 'accepted' }] });
  assert.equal(codeqlOutcome(value).status, 'fail');
});

await test('CodeQL missing or incompatible evidence is incomplete, not clean', () => {
  for (const value of [{}, { version: '2.1.0', runs: [] }, sarif('unknown'), sarif('11')]) {
    assert.throws(() => codeqlOutcome(value));
  }
  const failed = sarif('1.0');
  const invocation = failed.runs[0]?.invocations[0];
  assert.ok(invocation);
  invocation.executionSuccessful = false;
  assert.throws(() => codeqlOutcome(failed));
  const missingRules = sarif('1.0');
  missingRules.runs[0]?.tool.driver.rules.splice(0);
  assert.throws(() => codeqlOutcome(missingRules));
});
