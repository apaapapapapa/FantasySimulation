import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { array, isMain, main, object, requireCondition, text } from './common.ts';
import type { Outcome } from './common.ts';

export function codeqlOutcome(value: unknown): Outcome {
  const report = object(value);
  requireCondition(report.version === '2.1.0', 'UNSUPPORTED_SARIF_VERSION');
  const runs = array(report.runs);
  requireCondition(runs.length > 0, 'CODEQL_RUNS_MISSING');
  let findings = 0;
  let blocking = 0;
  let rulesCount = 0;
  for (const value of runs) {
    const run = object(value);
    const driver = object(object(run.tool).driver);
    requireCondition(driver.name === 'CodeQL', 'UNEXPECTED_SARIF_PRODUCER');
    const rules = array(driver.rules).map(object);
    requireCondition(rules.length > 0, 'CODEQL_RULES_MISSING');
    rulesCount += rules.length;
    const ids = new Map(rules.map((rule) => [text(rule.id), rule]));
    requireCondition(ids.size === rules.length, 'DUPLICATE_CODEQL_RULE');
    for (const invocation of array(run.invocations)) {
      requireCondition(object(invocation).executionSuccessful === true, 'CODEQL_EXECUTION_FAILED');
    }
    requireCondition(array(run.invocations).length > 0, 'CODEQL_INVOCATION_MISSING');
    for (const value of array(run.results)) {
      const result = object(value);
      const rule = ids.get(text(result.ruleId));
      requireCondition(rule !== undefined, 'CODEQL_RESULT_RULE_MISSING');
      const properties = rule.properties === undefined ? {} : object(rule.properties);
      const severity = properties['security-severity'];
      if (severity !== undefined) {
        requireCondition(
          typeof severity === 'string' && /^(?:10|[0-9])(?:\.\d+)?$/.test(severity),
          'INVALID_CODEQL_SECURITY_SEVERITY',
        );
        const score = Number(severity);
        requireCondition(score >= 0 && score <= 10, 'INVALID_CODEQL_SECURITY_SCORE');
        if (score >= 7) blocking += 1;
      } else if (Array.isArray(properties.tags) && properties.tags.includes('security')) {
        requireCondition(false, 'CODEQL_SECURITY_SEVERITY_MISSING');
      }
      // Count the full current inventory, including unchanged/suppressed results.
      findings += 1;
    }
  }
  return {
    status: blocking > 0 ? 'fail' : 'pass',
    reason: blocking > 0 ? 'CODEQL_HIGH_OR_CRITICAL_FINDINGS' : 'CODEQL_SEVERITY_POLICY_PASSED',
    counts: { runs: runs.length, rules: rulesCount, findings, blocking },
  };
}

function evaluate(): Outcome {
  const directory = text(process.argv[2]);
  const files = readdirSync(directory).filter((name) => name.endsWith('.sarif'));
  requireCondition(files.length === 1, 'EXPECTED_ONE_JAVASCRIPT_SARIF');
  const filename = text(files[0]);
  return codeqlOutcome(JSON.parse(readFileSync(join(directory, filename), 'utf8')) as unknown);
}

if (isMain(import.meta.url)) main('codeql-severity', evaluate);
