import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { array, count, isMain, main, object, requireCondition, text } from './common.ts';
import type { Outcome } from './common.ts';

type Component = {
  data: Record<string, unknown>;
  rules: Record<string, unknown>[];
  ids: Map<string, Record<string, unknown>>;
};

function component(value: unknown): Component {
  const data = object(value);
  text(data.name);
  const rules = data.rules === undefined ? [] : array(data.rules).map(object);
  const ids = new Map(rules.map((rule) => [text(rule.id), rule]));
  requireCondition(ids.size === rules.length, 'DUPLICATE_CODEQL_RULE');
  return { data, rules, ids };
}

function resultRule(
  result: Record<string, unknown>,
  driver: Component,
  extensions: Component[],
): Record<string, unknown> {
  const reference = result.rule === undefined ? {} : object(result.rule);
  let owner = driver;
  if (reference.toolComponent !== undefined) {
    const target = object(reference.toolComponent);
    if (target.index !== undefined) {
      const selected = extensions[count(target.index)];
      requireCondition(selected !== undefined, 'CODEQL_COMPONENT_MISSING');
      owner = selected;
    } else if (target.name !== undefined || target.guid !== undefined) {
      const matches = [driver, ...extensions].filter(
        (entry) =>
          (target.name === undefined || entry.data.name === text(target.name)) &&
          (target.guid === undefined || entry.data.guid === text(target.guid)),
      );
      requireCondition(matches.length === 1, 'CODEQL_COMPONENT_AMBIGUOUS_OR_MISSING');
      const selected = matches[0];
      requireCondition(selected !== undefined, 'CODEQL_COMPONENT_MISSING');
      owner = selected;
    }
    for (const field of ['name', 'guid']) {
      if (target[field] !== undefined) {
        requireCondition(owner.data[field] === text(target[field]), 'CODEQL_COMPONENT_MISMATCH');
      }
    }
  }
  const id = reference.id ?? result.ruleId;
  const index = reference.index ?? result.ruleIndex;
  requireCondition(id !== undefined || index !== undefined, 'CODEQL_RESULT_RULE_MISSING');
  const rule = index === undefined ? owner.ids.get(text(id)) : owner.rules[count(index)];
  requireCondition(rule !== undefined, 'CODEQL_RESULT_RULE_MISSING');
  for (const candidate of [result.ruleId, reference.id]) {
    if (candidate !== undefined) {
      requireCondition(rule.id === text(candidate), 'CODEQL_RESULT_RULE_MISMATCH');
    }
  }
  for (const candidate of [result.ruleIndex, reference.index]) {
    if (candidate !== undefined) {
      requireCondition(owner.rules[count(candidate)] === rule, 'CODEQL_RESULT_RULE_MISMATCH');
    }
  }
  if (reference.guid !== undefined) {
    requireCondition(rule.guid === text(reference.guid), 'CODEQL_RESULT_RULE_MISMATCH');
  }
  return rule;
}

export function codeqlOutcome(
  value: unknown,
  blockingLocation?: (rule: string, path: string, line: number) => void,
): Outcome {
  const report = object(value);
  requireCondition(report.version === '2.1.0', 'UNSUPPORTED_SARIF_VERSION');
  const runs = array(report.runs);
  requireCondition(runs.length > 0, 'CODEQL_RUNS_MISSING');
  let findings = 0;
  let blocking = 0;
  let rulesCount = 0;
  for (const value of runs) {
    const run = object(value);
    const tool = object(run.tool);
    const driver = component(tool.driver);
    requireCondition(driver.data.name === 'CodeQL', 'UNEXPECTED_SARIF_PRODUCER');
    // The pinned CodeQL action emits --sarif-group-rules-by-pack: driver.rules
    // can be empty while each query pack owns its rules in tool.extensions.
    const extensions = tool.extensions === undefined ? [] : array(tool.extensions).map(component);
    const totalRules = [driver, ...extensions].reduce(
      (total, entry) => total + entry.rules.length,
      0,
    );
    requireCondition(totalRules > 0, 'CODEQL_RULES_MISSING');
    rulesCount += totalRules;
    const invocations = array(run.invocations);
    requireCondition(invocations.length > 0, 'CODEQL_INVOCATION_MISSING');
    for (const value of invocations) {
      const invocation = object(value);
      requireCondition(invocation.executionSuccessful === true, 'CODEQL_EXECUTION_FAILED');
      for (const field of ['toolExecutionNotifications', 'toolConfigurationNotifications']) {
        if (invocation[field] === undefined) continue;
        for (const notification of array(invocation[field])) {
          requireCondition(object(notification).level !== 'error', 'CODEQL_REPORTED_ERROR');
        }
      }
    }
    for (const value of array(run.results)) {
      const result = object(value);
      const rule = resultRule(result, driver, extensions);
      const properties = rule.properties === undefined ? {} : object(rule.properties);
      const severity = properties['security-severity'];
      if (severity !== undefined) {
        requireCondition(
          typeof severity === 'string' && /^(?:10|[0-9])(?:\.\d+)?$/.test(severity),
          'INVALID_CODEQL_SECURITY_SEVERITY',
        );
        const score = Number(severity);
        requireCondition(score >= 0 && score <= 10, 'INVALID_CODEQL_SECURITY_SCORE');
        if (score >= 7) {
          blocking += 1;
          if (blockingLocation) {
            const locations = Array.isArray(result.locations) ? result.locations : [];
            for (const entry of locations.slice(0, 10)) {
              const location = object(object(entry).physicalLocation);
              const path = text(object(location.artifactLocation).uri);
              const line = count(object(location.region).startLine);
              const id = text(rule.id);
              // Print only bounded identifiers and locations, never source snippets or messages.
              if (/^[a-zA-Z0-9_./-]{1,200}$/.test(id) && /^[a-zA-Z0-9_./-]{1,300}$/.test(path))
                blockingLocation(id, path, line);
            }
          }
        }
      } else if (Array.isArray(properties.tags) && properties.tags.includes('security')) {
        requireCondition(false, 'CODEQL_SECURITY_SEVERITY_MISSING');
      }
      // Every emitted result counts, including unchanged and suppressed results.
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
  return codeqlOutcome(
    JSON.parse(readFileSync(join(directory, filename), 'utf8')) as unknown,
    (rule, path, line) => console.log(`CodeQL blocking finding: ${rule} at ${path}:${line}`),
  );
}

if (isMain(import.meta.url)) main('codeql-severity', evaluate);
