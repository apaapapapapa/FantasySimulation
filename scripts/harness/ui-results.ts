import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, join, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { record, text, identity, assessReport } from './report.ts';
import type { CheckStatus, Identity } from './report.ts';
import { UI_CASES, UI_CHECKS } from '../../e2e/contract.ts';
import { readBoundedJson } from './files.ts';

/** Validate relocated CI artifacts against the same run/attempt, raw files and attachments. */
export function readUiEvidence(
  directory: string,
  expected: Identity,
  run: { id: string; attempt: string },
) {
  const command = record(readBoundedJson(join(directory, 'command.json')));
  const info = identity(command);
  if (
    info.sourceSha !== expected.sourceSha ||
    info.candidateSha !== expected.candidateSha ||
    info.testMergeSha !== expected.testMergeSha ||
    (expected.testMergeSha && info.baselineSha !== expected.baselineSha) ||
    command.runId !== run.id ||
    command.runAttempt !== run.attempt
  )
    throw new Error('Stale UI source or CI attempt');
  const digests = record(command.digests);
  for (const file of [
    'run.json',
    'runner.log',
    'execution.json',
    'results.json',
    'coverage.json',
    'servers.json',
  ]) {
    if (
      createHash('sha256')
        .update(readFileSync(join(directory, file)))
        .digest('hex') !== digests[file]
    )
      throw new Error('Missing or changed UI raw artifact');
  }
  const coverage = record(readBoundedJson(join(directory, 'coverage.json')));
  const raw = record(readBoundedJson(join(directory, 'results.json')));
  const projects = record(raw.config).projects;
  if (!Array.isArray(projects) || projects.length !== 1)
    throw new Error('Missing Chromium configuration');
  const original = dirname(text(record(projects[0]).outputDir));
  const recollected = uiCoverage(raw, directory, original);
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
  const assessment = assessReport(readBoundedJson(join(directory, 'report.json')), UI_CHECKS);
  if (
    assessment.exitCode === 0 &&
    (command.exitCode !== 0 ||
      command.bounded !== false ||
      command.temporaryRemoved !== true ||
      command.serversStopped !== true ||
      coverage.status !== 'pass')
  )
    throw new Error('UI summary contradicts its command/coverage');
  return assessment.report;
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
    const observed = specs.map((spec) => text(spec.title));
    if (
      observed.length !== UI_CASES.length ||
      UI_CASES.some((id) => observed.filter((title) => title === id).length !== 1)
    )
      throw new Error('Required case missing/duplicated or unexpected case');
    for (const spec of specs) {
      if (!Array.isArray(spec.tests) || spec.tests.length !== 1)
        throw new Error('Expected exactly one Chromium project');
      const test = record(spec.tests[0]);
      if (
        test.projectName !== 'chromium' ||
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
        if (identity.name !== 'chromium' || !text(identity.version))
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
          testId: text(spec.id),
          caseId: text(spec.title),
          retry: index,
          status,
          browser: identity,
          attachments: files,
        });
        if (status === 'skipped' || status === 'interrupted')
          throw new Error('Unexecuted/interrupted test');
        if (status !== 'passed' && !attachments.some((item) => item.name === 'trace' && item.path))
          throw new Error('Failed attempt lacks trace');
      }
    }
    return {
      status: attempts.every((attempt) => attempt.status === 'passed') ? 'pass' : 'fail',
      attempts,
      reason:
        'All required Chromium cases executed; a failed first attempt remains a failure even after retry',
    };
  } catch (error) {
    return {
      status: 'unknown',
      attempts,
      reason: error instanceof Error ? error.message : 'Invalid Playwright evidence',
    };
  }
}
