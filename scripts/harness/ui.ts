import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { artifactDirectory, git, repositoryRoot, sourceIdentity } from './source.ts';
import { runCommand, safeEnvironment } from './process.ts';
import { assessReport } from './report.ts';
import type { Report } from './report.ts';
import {
  inspectUiDiagnostics,
  inspectUiStatic,
  staticEvidence,
  uiCoverage,
  uiProducer,
} from './ui-results.ts';
import {
  UI_CHECKS,
  UI_RUN_CHECKS,
  UI_FAULTS,
  UI_STATIC_SCENARIOS,
  isStaticScenario,
  uiSettings,
  uiCases,
  uiBrowsers,
  type UiPart,
  type UiScenario,
} from '../../e2e/contract.ts';

/**
 * `all` runs every suite in one process (local use). CI runs each part in its own job: the
 * interactive part keeps the editor/battle report and fault probes at the root, and each static
 * part writes `static/<part>`; the gate recombines and rechecks them from raw artifacts.
 */
export async function collectUi(
  input: string,
  relative = `.generated/harness/ui-${randomUUID()}`,
  part: UiPart | 'all' = 'all',
) {
  if (part !== 'all' && part !== 'interactive')
    return await runUiOnce(input, `${relative}/static/${part}`, part);
  const result = await runUiOnce(input, relative, 'smoke');
  const run = {
    id: process.env.GITHUB_RUN_ID ?? null,
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  };
  let diagnostics;
  let staticResult;
  try {
    if (result.interrupted) throw new Error('UI execution interrupted');
    for (const scenario of UI_FAULTS) {
      const probe = await runUiOnce(input, `${relative}/diagnostics/${scenario}`, scenario);
      if (probe.interrupted) throw new Error('UI diagnostics interrupted');
    }
    if (part === 'all') {
      for (const scenario of UI_STATIC_SCENARIOS) {
        const probe = await runUiOnce(input, `${relative}/static/${scenario}`, scenario);
        if (probe.interrupted) throw new Error('UI static execution interrupted');
      }
      staticResult = inspectUiStatic(join(input, relative), result.report, run);
    }
    diagnostics = inspectUiDiagnostics(join(input, relative), result.report, run);
  } catch (error) {
    diagnostics = {
      status: 'unknown' as const,
      reason: error instanceof Error ? error.message : 'Missing diagnostic evidence',
    };
  }
  result.report.checks.push({
    id: 'ui:diagnostics',
    required: true,
    ...diagnostics,
    evidence: UI_FAULTS.map((scenario) => ({
      uri: `${relative}/diagnostics/${scenario}/command.json`,
      sourceSha: result.report.sourceSha,
    })),
  });
  if (part === 'all')
    result.report.checks.push({
      id: 'ui:static-replay',
      required: true,
      ...(staticResult ?? {
        status: 'unknown' as const,
        reason: 'Static browser execution did not complete',
      }),
      evidence: staticEvidence(relative, result.report.sourceSha),
    });
  result.report.finishedAt = new Date().toISOString();
  const assessment = assessReport(
    result.report,
    part === 'all' ? UI_CHECKS : [...UI_RUN_CHECKS, 'ui:diagnostics'],
  );
  writeFileSync(
    join(input, relative, 'report.json'),
    JSON.stringify(assessment.report, null, 2) + '\n',
  );
  return assessment;
}

async function runUiOnce(input: string, relative: string, scenario: UiScenario) {
  const root = repositoryRoot(input);
  const info = sourceIdentity(root);
  const before = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const directory = artifactDirectory(root, relative);
  const temporary = mkdtempSync(join(tmpdir(), 'fantasy-e2e-'));
  const startedAt = new Date().toISOString();
  const save = (file: string, value: unknown) =>
    writeFileSync(join(directory, file), JSON.stringify(value, null, 2) + '\n');
  save('run.json', {
    ...info,
    startedAt,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  });
  const require = createRequire(import.meta.url);
  const loader = require.resolve('tsx', { paths: [join(root, 'apps/api')] });
  const env = {
    ...safeEnvironment(process.env),
    // Each tool receives only safe process settings and generated local paths, never API/DB overrides or .env.
    FANTASY_UI_OUTPUT: directory,
    FANTASY_UI_TEMP: temporary,
    PLAYWRIGHT_BROWSERS_PATH: join(root, '.generated', 'playwright'),
    NO_COLOR: '1',
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let removed = false;
  let result;
  try {
    result = await runCommand(
      process.execPath,
      ['--import', loader, 'e2e/runner.ts', scenario],
      root,
      {
        env,
        timeoutMs: uiSettings(scenario).globalTimeout + 60_000,
        maxBytes: 4 * 1024 * 1024,
        signal: controller.signal,
      },
    );
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    try {
      rmSync(temporary, { recursive: true, force: true });
      removed = !existsSync(temporary);
    } catch {
      /* Preserve failure evidence even when cleanup fails. */
    }
  }
  writeFileSync(join(directory, 'runner.log'), result.output);
  if ((scenario === 'smoke' || isStaticScenario(scenario)) && result.exitCode !== 0)
    console.error(result.output);
  let results: unknown = null;
  try {
    results = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8')) as unknown;
  } catch {
    /* Unstarted browser remains unknown. */
  }
  const coverage = uiCoverage(
    results,
    directory,
    directory,
    uiCases(scenario),
    uiBrowsers(scenario),
  );
  save('coverage.json', coverage);
  let serversStopped = false;
  try {
    serversStopped =
      (JSON.parse(readFileSync(join(directory, 'servers.json'), 'utf8')) as { stopped?: unknown })
        .stopped === true;
  } catch {
    /* Startup failure/forced exit has no successful graceful shutdown receipt. */
  }
  const digests = Object.fromEntries(
    [
      'run.json',
      'runner.log',
      'execution.json',
      'results.json',
      'coverage.json',
      'servers.json',
      'lifecycle.json',
      'failure.json',
    ]
      .filter((file) => existsSync(join(directory, file)))
      .map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(join(directory, file)))
          .digest('hex'),
      ]),
  );
  save('command.json', {
    ...info,
    startedAt,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    command: ['node', '--import', 'tsx', 'e2e/runner.ts', scenario],
    scenario,
    exitCode: result.exitCode,
    signal: result.signal,
    bounded: result.bounded,
    temporaryRemoved: removed,
    serversStopped,
    digests,
  });
  const clean =
    !before &&
    !git(root, ['status', '--porcelain=v1', '--untracked-files=all']) &&
    git(root, ['rev-parse', 'HEAD']) === info.sourceSha;
  const evidence = [
    { uri: `${relative}/command.json`, sourceSha: info.sourceSha },
    { uri: `${relative}/coverage.json`, sourceSha: info.sourceSha },
  ];
  const report: Report = {
    ...info,
    schemaVersion: 1,
    producer: uiProducer(scenario),
    startedAt,
    finishedAt: new Date().toISOString(),
    checks: [
      {
        id: 'ui:source',
        required: true,
        status: clean ? 'pass' : 'unknown',
        reason: 'Clean unchanged source required; dirty runs are diagnostic only',
        evidence,
      },
      {
        id: 'ui:execution',
        required: true,
        status: result.exitCode === 0 && !result.bounded ? 'pass' : 'fail',
        reason: `Browser command exit=${result.exitCode}; bounded=${result.bounded}; inspect runner.log`,
        evidence,
      },
      {
        id: 'ui:coverage',
        required: true,
        status: coverage.status,
        reason: coverage.reason,
        evidence,
      },
      {
        id: 'ui:cleanup',
        required: true,
        status: removed && serversStopped ? 'pass' : 'fail',
        reason: `Temporary data removed=${removed}; graceful server shutdown=${serversStopped}; forced exits remain failures`,
        evidence,
      },
      {
        id: 'ui:p4-editor-battle',
        required: scenario === 'smoke',
        status: scenario === 'smoke' ? coverage.status : 'unknown',
        reason:
          'Required cases exercise draft validation/publication and real async battle/cancel/retry/result/replay; engine correctness belongs to #9',
        evidence,
      },
    ],
  };
  const assessment = assessReport(report, UI_RUN_CHECKS);
  save('report.json', assessment.report);
  console.log(`UI evidence: ${relative}`);
  return { ...assessment, interrupted: controller.signal.aborted };
}
