import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, join, dirname, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { record, text, identity, assessReport } from './report.ts';
import type { CheckStatus, Identity } from './report.ts';
import {
  UI_CASES,
  UI_CHECKS,
  UI_RUN_CHECKS,
  UI_FAULTS,
  UI_STATIC_SCENARIOS,
  isStaticScenario,
  uiCases,
  uiBrowsers,
  uiSettings,
  localOrigin,
  type UiScenario,
} from '../../e2e/contract.ts';
import { readBoundedJson } from './files.ts';

export const uiProducer = (scenario: UiScenario) =>
  scenario === 'smoke' ? 'ui-runner' : isStaticScenario(scenario) ? 'ui-static' : 'ui-diagnostic';
export const staticEvidence = (relative: string, sourceSha: string) =>
  UI_STATIC_SCENARIOS.map((part) => ({
    uri: `${relative}/static/${part}/command.json`,
    sourceSha,
  }));

/**
 * Validate relocated CI artifacts against the same run/attempt, raw files and attachments. CI
 * runs the static parts in separate jobs, so the static result is recomputed here from their raw
 * evidence; a report that already claims it (a local run of every suite) must agree.
 */
export function readUiEvidence(
  directory: string,
  expected: Identity,
  run: { id: string; attempt: string },
) {
  const report = readUiRun(directory, expected, run);
  const observed = inspectUiDiagnostics(directory, expected, run);
  if (
    observed.status !== 'pass' ||
    report.checks.find((check) => check.id === 'ui:diagnostics')?.status !== observed.status
  )
    throw new Error('Missing or inconsistent UI diagnostic evidence');
  const staticResult = inspectUiStatic(directory, expected, run);
  const claimed = report.checks.find((check) => check.id === 'ui:static-replay');
  // Every part was written below the interactive report's output, so receipts share its base.
  const base = posix.dirname(
    report.checks.find((check) => check.id === 'ui:source')?.evidence[0]?.uri ??
      '.generated/harness/ui/command.json',
  );
  if (staticResult.status !== 'pass' || (claimed && claimed.status !== 'pass'))
    throw new Error('Missing or inconsistent static UI evidence');
  return assessReport(
    {
      ...report,
      checks: [
        ...report.checks.filter((check) => check.id !== 'ui:static-replay'),
        {
          id: 'ui:static-replay',
          required: true,
          ...staticResult,
          evidence: staticEvidence(base, report.sourceSha),
        },
      ],
    },
    UI_CHECKS,
  ).report;
}

export function readUiRun(
  directory: string,
  expected: Identity,
  run: { id: string | null; attempt: string | null },
  scenario: UiScenario = 'smoke',
) {
  const command = record(readBoundedJson(join(directory, 'command.json')));
  const info = identity(command);
  if (
    info.sourceSha !== expected.sourceSha ||
    info.candidateSha !== expected.candidateSha ||
    info.testMergeSha !== expected.testMergeSha ||
    (expected.testMergeSha && info.baselineSha !== expected.baselineSha) ||
    command.runId !== run.id ||
    command.runAttempt !== run.attempt ||
    command.scenario !== scenario
  )
    throw new Error('Stale UI source or CI attempt');
  const digests = record(command.digests);
  const runReceipt = record(readBoundedJson(join(directory, 'run.json')));
  if (
    !isDeepStrictEqual(identity(runReceipt), info) ||
    runReceipt.runId !== run.id ||
    runReceipt.runAttempt !== run.attempt
  )
    throw new Error('UI run receipt identity mismatch');
  if (
    scenario !== 'startup' &&
    !isDeepStrictEqual(record(readBoundedJson(join(directory, 'execution.json'))).run, runReceipt)
  )
    throw new Error('UI execution does not belong to this run');
  const files = [
    'run.json',
    'runner.log',
    'coverage.json',
    'servers.json',
    'lifecycle.json',
    ...(scenario === 'startup' ? ['failure.json'] : ['execution.json', 'results.json']),
    ...(existsSync(join(directory, 'failure.json')) && scenario !== 'startup'
      ? ['failure.json']
      : []),
  ];
  for (const file of files) {
    if (
      createHash('sha256')
        .update(readFileSync(join(directory, file)))
        .digest('hex') !== digests[file]
    )
      throw new Error('Missing or changed UI raw artifact');
  }
  const coverage = record(readBoundedJson(join(directory, 'coverage.json')));
  const raw =
    scenario === 'startup' ? null : record(readBoundedJson(join(directory, 'results.json')));
  let original = directory;
  if (raw) {
    const projects = record(raw.config).projects;
    if (!Array.isArray(projects) || projects.length !== uiBrowsers(scenario).length)
      throw new Error('Missing required browser configuration');
    original = dirname(text(record(projects[0]).outputDir));
  }
  const recollected = uiCoverage(raw, directory, original, uiCases(scenario), uiBrowsers(scenario));
  if (!isDeepStrictEqual(coverage, recollected))
    throw new Error('UI coverage does not match raw execution');
  if (!Array.isArray(coverage.attempts)) throw new Error('Missing UI attempt coverage');
  for (const value of coverage.attempts) {
    const attempt = record(value);
    if (!Array.isArray(attempt.attachments)) throw new Error('Missing attachment inventory');
    for (const value of attempt.attachments) {
      const artifact = record(value);
      const path = text(artifact.path);
      if (
        isAbsolute(path) ||
        path.split(/[\\/]/).includes('..') ||
        createHash('sha256')
          .update(readFileSync(join(directory, path)))
          .digest('hex') !== artifact.sha256
      )
        throw new Error('Missing or changed UI attachment');
    }
  }
  const assessment = assessReport(readBoundedJson(join(directory, 'report.json')), UI_RUN_CHECKS);
  const report = assessment.report;
  if (
    report.sourceSha !== info.sourceSha ||
    report.candidateSha !== info.candidateSha ||
    report.testMergeSha !== info.testMergeSha ||
    report.baselineSha !== info.baselineSha ||
    report.producer !== uiProducer(scenario)
  )
    throw new Error('UI report identity mismatch');
  if (
    assessment.exitCode === 0 &&
    (command.exitCode !== 0 ||
      command.bounded !== false ||
      command.temporaryRemoved !== true ||
      command.serversStopped !== true ||
      coverage.status !== 'pass')
  )
    throw new Error('UI summary contradicts its command/coverage');
  const lifecycle = readBoundedJson(join(directory, 'lifecycle.json'));
  const stages =
    scenario === 'startup'
      ? ['server-start', 'api-ready', 'servers-stopped', 'failure']
      : [
          'server-start',
          isStaticScenario(scenario) ? 'fixtures-ready' : 'api-ready',
          'web-ready',
          'browser',
          'browser-finished',
          'servers-stopped',
        ];
  if (!Array.isArray(lifecycle) || lifecycle.length !== stages.length)
    throw new Error('Missing UI lifecycle stages');
  let previous = Date.parse(report.startedAt);
  for (const [index, value] of lifecycle.entries()) {
    const entry = record(value),
      at = Date.parse(text(entry.at));
    if (
      entry.stage !== stages[index] ||
      !Number.isFinite(at) ||
      at < previous ||
      at > Date.parse(report.finishedAt)
    )
      throw new Error('Invalid UI lifecycle stage order or timestamp');
    previous = at;
  }
  return assessment.report;
}

export function inspectUiStatic(
  directory: string,
  expected: Identity,
  run: { id: string | null; attempt: string | null },
): { status: CheckStatus; reason: string } {
  try {
    for (const part of UI_STATIC_SCENARIOS) {
      const folder = join(directory, 'static', part);
      const report = readUiRun(folder, expected, run, part);
      const execution = record(readBoundedJson(join(folder, 'execution.json')));
      const origins = record(execution.origins);
      const servers = record(readBoundedJson(join(folder, 'servers.json')));
      if (
        assessReport(report, UI_RUN_CHECKS).exitCode !== 0 ||
        !isDeepStrictEqual(execution.settings, uiSettings(part)) ||
        origins.api !== null ||
        servers.apiOrigin !== null ||
        !isDeepStrictEqual(execution.samples, []) ||
        localOrigin(text(origins.web)) === localOrigin(text(origins.data)) ||
        servers.webOrigin !== origins.web ||
        servers.dataOrigin !== origins.data ||
        servers.stopped !== true
      )
        throw new Error(`Static ${part} did not pass in independent API-free origins`);
    }
    return {
      status: 'pass',
      reason:
        'Chromium and WebKit exercised static selection, recorded 3D replay and failures without API/SQLite/engine execution',
    };
  } catch (error) {
    return {
      status: 'unknown',
      reason: error instanceof Error ? error.message : 'Missing static evidence',
    };
  }
}

export function inspectUiDiagnostics(
  directory: string,
  expected: Identity,
  run: { id: string | null; attempt: string | null },
): { status: CheckStatus; reason: string } {
  try {
    for (const scenario of UI_FAULTS) {
      const folder = join(directory, 'diagnostics', scenario);
      const report = readUiRun(folder, expected, run, scenario);
      const command = record(readBoundedJson(join(folder, 'command.json')));
      const servers = record(readBoundedJson(join(folder, 'servers.json')));
      if (
        command.exitCode === 0 ||
        command.bounded !== false ||
        command.temporaryRemoved !== true ||
        command.serversStopped !== true ||
        servers.stopped !== true ||
        report.checks.find((check) => check.id === 'ui:source')?.status !== 'pass' ||
        report.checks.find((check) => check.id === 'ui:execution')?.status !== 'fail'
      )
        throw new Error(`Unverified ${scenario} failure or cleanup`);
      if (scenario === 'startup') {
        const failure = record(readBoundedJson(join(folder, 'failure.json')));
        if (
          failure.stage !== 'server-start' ||
          !text(failure.message) ||
          !servers.apiOrigin ||
          servers.webOrigin !== null
        )
          throw new Error('Partial startup failure was not exercised');
        continue;
      }
      const coverage = record(readBoundedJson(join(folder, 'coverage.json')));
      const attempts = coverage.attempts;
      if (
        coverage.status !== 'fail' ||
        !Array.isArray(attempts) ||
        attempts.length !== 1 ||
        record(attempts[0]).status !== (scenario === 'timeout' ? 'timedOut' : 'failed')
      )
        throw new Error(`Expected actual ${scenario} execution`);
      const raw = record(readBoundedJson(join(folder, 'results.json')));
      const suites = raw.suites;
      if (!Array.isArray(suites)) throw new Error('Missing diagnostic result');
      const specs = record(suites[0]).specs;
      if (!Array.isArray(specs)) throw new Error('Missing diagnostic case');
      const tests = record(specs[0]).tests;
      if (!Array.isArray(tests)) throw new Error('Missing diagnostic browser');
      const results = record(tests[0]).results;
      if (!Array.isArray(results)) throw new Error('Missing diagnostic attempt');
      const attachments = record(results[0]).attachments;
      if (!Array.isArray(attachments)) throw new Error('Missing diagnostic artifacts');
      const bodies = attachments.map(record);
      if (!bodies.some((a) => a.name === 'before-fault' && (a.path || a.body)))
        throw new Error('Pre-failure screenshot missing');
      if (
        scenario === 'crash' &&
        !bodies.some(
          (a) =>
            a.name === 'fault-observed' &&
            Buffer.from(text(a.body), 'base64').toString('utf8') === 'browser-disconnected',
        )
      )
        throw new Error('Browser crash not observed');
    }
    return {
      status: 'pass',
      reason:
        'Real partial startup failure, test timeout and browser crash retained evidence and cleaned up',
    };
  } catch (error) {
    return {
      status: 'unknown',
      reason: error instanceof Error ? error.message : 'Invalid diagnostic evidence',
    };
  }
}

export interface UiAttempt {
  testId: string;
  caseId: string;
  retry: number;
  status: string;
  browser: unknown;
  attachments: { path: string; sha256: string }[];
}
/** Parse actual Playwright execution, including the failed first attempt of a flaky case. */
export function uiCoverage(
  input: unknown,
  directory: string,
  originalDirectory = directory,
  cases: readonly string[] = UI_CASES,
  browsers: readonly string[] = ['chromium'],
): { status: CheckStatus; attempts: UiAttempt[]; reason: string } {
  const attempts: UiAttempt[] = [];
  try {
    const result = record(input);
    if (!Array.isArray(result.errors) || result.errors.length)
      throw new Error('Runner errors or missing results');
    const specs: Record<string, unknown>[] = [];
    function visit(value: unknown) {
      if (!Array.isArray(value)) throw new Error('Missing suite inventory');
      for (const entry of value) {
        const suite = record(entry);
        if (!Array.isArray(suite.specs)) throw new Error('Missing test inventory');
        specs.push(...suite.specs.map(record));
        visit(suite.suites ?? []);
      }
    }
    visit(result.suites);
    // Playwright may emit a separate spec ID for each project. Coverage belongs
    // to the case/browser pair, not to the JSON reporter's grouping of specs.
    const observed = specs.flatMap((spec) => {
      if (!Array.isArray(spec.tests) || !spec.tests.length)
        throw new Error('Missing browser test inventory');
      return spec.tests.map((test) => ({
        caseId: text(spec.title),
        browser: text(record(test).projectName),
      }));
    });
    if (
      observed.length !== cases.length * browsers.length ||
      cases.some((id) =>
        browsers.some(
          (browser) =>
            observed.filter((test) => test.caseId === id && test.browser === browser).length !== 1,
        ),
      )
    )
      throw new Error('Required case/browser missing, duplicated or unexpected');
    for (const spec of specs) {
      const projects = spec.tests;
      if (!Array.isArray(projects)) throw new Error('Missing browser project');
      for (const project of projects) {
        const test = record(project);
        if (
          !browsers.includes(text(test.projectName)) ||
          test.expectedStatus !== 'passed' ||
          !Array.isArray(test.results) ||
          !test.results.length
        )
          throw new Error('Required browser test was not executed');
        for (const [index, value] of test.results.entries()) {
          const attempt = record(value);
          if (attempt.retry !== index || index > 1 || !Array.isArray(attempt.attachments))
            throw new Error('Incomplete retry history');
          const attachments = attempt.attachments.map(record);
          const browser = attachments.filter((item) => item.name === 'browser-identity');
          if (browser.length !== 1) throw new Error('Browser did not start');
          const identity = record(
            JSON.parse(Buffer.from(text(browser[0]!.body), 'base64').toString('utf8')) as unknown,
          );
          if (identity.name !== test.projectName || !text(identity.version))
            throw new Error('Missing browser identity');
          const files = attachments
            .filter((item) => item.path !== undefined)
            .map((item) => {
              const path = relative(originalDirectory, resolve(text(item.path)));
              const file = resolve(directory, path);
              if (!path || path.startsWith('..') || isAbsolute(path) || !existsSync(file))
                throw new Error('Missing or unsafe failure artifact');
              return {
                path: path.replaceAll('\\', '/'),
                sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
              };
            });
          const status = text(attempt.status);
          attempts.push({
            testId: `${text(spec.id)}:${text(test.projectName)}`,
            caseId: text(spec.title),
            retry: index,
            status,
            browser: identity,
            attachments: files,
          });
          if (status === 'skipped' || status === 'interrupted')
            throw new Error('Unexecuted/interrupted test');
          if (
            status !== 'passed' &&
            !attachments.some((item) => item.name === 'trace' && item.path)
          )
            throw new Error('Failed attempt lacks trace');
        }
      }
    }
    return {
      status: attempts.every((attempt) => attempt.status === 'passed') ? 'pass' : 'fail',
      attempts,
      reason:
        'All required cases and browsers executed; a failed first attempt remains a failure even after retry',
    };
  } catch (error) {
    return {
      status: 'unknown',
      attempts,
      reason: error instanceof Error ? error.message : 'Invalid Playwright evidence',
    };
  }
}
