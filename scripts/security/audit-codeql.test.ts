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

function groupedSarif(score = '8.0', results = true) {
  const extension = {
    name: 'codeql/javascript-queries',
    guid: '11111111-1111-4111-8111-111111111111',
    rules: [{ id: 'js/test', properties: { 'security-severity': score } }],
  };
  const run = {
    tool: { driver: { name: 'CodeQL', rules: [] }, extensions: [extension] },
    invocations: [{ executionSuccessful: true }],
    results: results
      ? [
          {
            ruleId: 'js/test',
            rule: { id: 'js/test', index: 0, toolComponent: { index: 0 } },
            baselineState: 'unchanged',
          },
        ]
      : [],
  };
  return { version: '2.1.0', runs: [run] };
}

await test('grouped query-pack inventory with no findings is clean, not missing rules', () => {
  const value = groupedSarif('8.0', false);
  assert.deepEqual(codeqlOutcome(value), {
    status: 'pass',
    reason: 'CODEQL_SEVERITY_POLICY_PASSED',
    counts: { runs: 1, rules: 1, findings: 0, blocking: 0 },
  });
  Reflect.deleteProperty(value.runs[0]?.tool.driver ?? {}, 'rules');
  assert.equal(codeqlOutcome(value).status, 'pass');
});

await test('grouped high/critical findings block even when suppressed or unchanged', () => {
  for (const score of ['7.0', '9.8']) {
    const value = groupedSarif(score);
    Object.assign(value.runs[0]?.results[0] ?? {}, { suppressions: [{ status: 'accepted' }] });
    assert.equal(codeqlOutcome(value).status, 'fail');
    assert.equal(codeqlOutcome(value).counts.blocking, 1);
  }
  assert.equal(codeqlOutcome(groupedSarif('6.9')).status, 'pass');
});

await test('rule ids are resolved in their owning component instead of a flattened map', () => {
  const value = groupedSarif('6.9');
  const run = value.runs[0];
  assert.ok(run);
  run.tool.extensions.push({
    name: 'local/security-queries',
    guid: '22222222-2222-4222-8222-222222222222',
    rules: [{ id: 'js/test', properties: { 'security-severity': '9.8' } }],
  });
  assert.equal(codeqlOutcome(value).status, 'pass');
  const result = run.results[0];
  assert.ok(result);
  result.rule.toolComponent.index = 1;
  assert.equal(codeqlOutcome(value).status, 'fail');
});

await test('component names and guids must resolve uniquely and agree with indices', () => {
  for (const target of [
    { name: 'codeql/javascript-queries' },
    { guid: '11111111-1111-4111-8111-111111111111' },
    { index: 0, name: 'codeql/javascript-queries' },
  ]) {
    const value = groupedSarif();
    Object.assign(value.runs[0]?.results[0]?.rule ?? {}, { toolComponent: target });
    assert.equal(codeqlOutcome(value).status, 'fail');
  }
  for (const target of [
    { index: 1 },
    { index: -1 },
    { index: 0.5 },
    { index: 0, name: 'wrong-pack' },
    { index: 0, guid: 'wrong-guid' },
    { name: 'unknown-pack' },
  ]) {
    const value = groupedSarif();
    Object.assign(value.runs[0]?.results[0]?.rule ?? {}, { toolComponent: target });
    assert.throws(() => codeqlOutcome(value));
  }
});

await test('nested rule ids and indices cannot disagree with legacy result references', () => {
  for (const update of [
    { ruleId: 'js/other' },
    { ruleIndex: 1 },
    { rule: { id: 'js/other', index: 0, toolComponent: { index: 0 } } },
    { rule: { id: 'js/test', index: 99, toolComponent: { index: 0 } } },
  ]) {
    const value = groupedSarif();
    Object.assign(value.runs[0]?.results[0] ?? {}, update);
    assert.throws(() => codeqlOutcome(value));
  }
  const nestedOnly = groupedSarif();
  Reflect.deleteProperty(nestedOnly.runs[0]?.results[0] ?? {}, 'ruleId');
  assert.equal(codeqlOutcome(nestedOnly).status, 'fail');
});

await test('empty rules everywhere, missing results and failed invocations never pass', () => {
  const emptyRules = groupedSarif('8.0', false);
  emptyRules.runs[0]?.tool.extensions.splice(0);
  assert.throws(() => codeqlOutcome(emptyRules));
  const missingResults = groupedSarif('8.0', false);
  Reflect.deleteProperty(missingResults.runs[0] ?? {}, 'results');
  assert.throws(() => codeqlOutcome(missingResults));
  const missingInvocations = groupedSarif('8.0', false);
  missingInvocations.runs[0]?.invocations.splice(0);
  assert.throws(() => codeqlOutcome(missingInvocations));
  for (const field of ['toolExecutionNotifications', 'toolConfigurationNotifications']) {
    const failed = groupedSarif('8.0', false);
    Object.assign(failed.runs[0]?.invocations[0] ?? {}, { [field]: [{ level: 'error' }] });
    assert.throws(() => codeqlOutcome(failed));
  }
});

await test('duplicate pack rules and invalid security metadata remain incomplete', () => {
  const duplicate = groupedSarif();
  duplicate.runs[0]?.tool.extensions[0]?.rules.push({
    id: 'js/test',
    properties: { 'security-severity': '1.0' },
  });
  assert.throws(() => codeqlOutcome(duplicate));
  for (const score of ['unknown', '11', '-1']) {
    assert.throws(() => codeqlOutcome(groupedSarif(score)));
  }
  const missingSeverity = groupedSarif();
  Object.assign(missingSeverity.runs[0]?.tool.extensions[0]?.rules[0] ?? {}, {
    properties: { tags: ['security'] },
  });
  assert.throws(() => codeqlOutcome(missingSeverity));
});
