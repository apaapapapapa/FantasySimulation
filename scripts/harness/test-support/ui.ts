import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UI_CASES,
  UI_RUN_CHECKS,
  UI_FAULTS,
  isStaticScenario,
  uiBrowsers,
  uiCases,
  uiSettings,
  type UiScenario,
} from '../../../e2e/contract.ts';
import { uiCoverage, uiProducer } from '../ui-results.ts';

export function uiResults(
  cases: readonly string[] = UI_CASES,
  browsers: readonly string[] = ['chromium'],
) {
  return {
    errors: [],
    suites: [
      {
        specs: cases.flatMap((title) =>
          browsers.map((name) => ({
            id: `stable-${title}-${name}`,
            title,
            tests: [
              {
                projectName: name,
                expectedStatus: 'passed',
                results: [
                  {
                    retry: 0,
                    status: 'passed',
                    attachments: [
                      {
                        name: 'browser-identity',
                        body: Buffer.from(JSON.stringify({ name, version: '123.0' })).toString(
                          'base64',
                        ),
                        path: undefined as string | undefined,
                      },
                    ],
                  },
                ],
              },
            ],
          })),
        ),
      },
    ],
  };
}

export const uiIdentity = {
  sourceSha: 'a'.repeat(40),
  candidateSha: 'a'.repeat(40),
  baselineSha: null,
  testMergeSha: null,
};
type UiRunId = { id: string; attempt: string };
const RUN_FILES = [
  'run.json',
  'runner.log',
  'execution.json',
  'results.json',
  'coverage.json',
  'servers.json',
  'lifecycle.json',
];
function commandDigests(folder: string, files: readonly string[]) {
  return Object.fromEntries(
    files.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(join(folder, file)))
        .digest('hex'),
    ]),
  );
}

/** Writes one relocated passing run as the harness records it, including raw-file digests. */
export function writeUiRun(
  directory: string,
  scenario: UiScenario,
  run: UiRunId,
  checks: readonly string[] = UI_RUN_CHECKS,
) {
  mkdirSync(directory, { recursive: true });
  const isStatic = isStaticScenario(scenario);
  const write = (file: string, value: unknown) =>
    writeFileSync(join(directory, file), JSON.stringify(value));
  const raw = {
    ...uiResults(uiCases(scenario), uiBrowsers(scenario)),
    config: {
      projects: uiBrowsers(scenario).map(() => ({ outputDir: '/original/checkout/ui/tests' })),
    },
  };
  const runReceipt = { ...uiIdentity, runId: run.id, runAttempt: run.attempt };
  write('run.json', runReceipt);
  write('runner.log', {});
  write('execution.json', {
    run: runReceipt,
    settings: uiSettings(scenario),
    origins: {
      web: 'http://127.0.0.1:1234',
      api: isStatic ? null : 'http://127.0.0.1:1236',
      data: isStatic ? 'http://127.0.0.1:1235' : null,
    },
    samples: [],
  });
  write('servers.json', {
    stopped: true,
    apiOrigin: isStatic ? null : 'http://127.0.0.1:1236',
    webOrigin: 'http://127.0.0.1:1234',
    dataOrigin: isStatic ? 'http://127.0.0.1:1235' : null,
  });
  write(
    'lifecycle.json',
    [
      'server-start',
      isStatic ? 'fixtures-ready' : 'api-ready',
      'web-ready',
      'browser',
      'browser-finished',
      'servers-stopped',
    ].map((stage) => ({ stage, at: '2026-09-23T00:00:00Z' })),
  );
  write('results.json', raw);
  write(
    'coverage.json',
    uiCoverage(raw, directory, '/original/checkout/ui', uiCases(scenario), uiBrowsers(scenario)),
  );
  write('command.json', {
    ...uiIdentity,
    runId: run.id,
    runAttempt: run.attempt,
    scenario,
    exitCode: 0,
    bounded: false,
    temporaryRemoved: true,
    serversStopped: true,
    digests: commandDigests(directory, RUN_FILES),
  });
  write('report.json', {
    ...uiIdentity,
    schemaVersion: 1,
    producer: uiProducer(scenario),
    startedAt: '2026-09-23T00:00:00Z',
    finishedAt: '2026-09-23T00:00:01Z',
    checks: checks.map((id) => ({
      id,
      required: true,
      status: 'pass',
      reason: 'fixture',
      evidence: [{ uri: '.generated/harness/ui/command.json', sourceSha: uiIdentity.sourceSha }],
    })),
  });
}

/** Writes one expected-failure probe with its retained artifacts and graceful cleanup. */
export function writeUiProbe(root: string, scenario: (typeof UI_FAULTS)[number], run: UiRunId) {
  const folder = join(root, 'diagnostics', scenario);
  mkdirSync(folder, { recursive: true });
  const artifacts: Record<string, unknown> = {
    'run.json': { ...uiIdentity, runId: run.id, runAttempt: run.attempt },
    'runner.log': 'expected failure log',
    'lifecycle.json': (scenario === 'startup'
      ? ['server-start', 'api-ready', 'servers-stopped', 'failure']
      : ['server-start', 'api-ready', 'web-ready', 'browser', 'browser-finished', 'servers-stopped']
    ).map((stage, index) => ({ stage, at: `2026-09-23T00:00:00.${index}00Z` })),
    'servers.json': {
      stopped: true,
      apiOrigin: 'http://127.0.0.1:1234',
      webOrigin: scenario === 'startup' ? null : 'http://127.0.0.1:1235',
    },
  };
  if (scenario === 'startup') {
    artifacts['failure.json'] = { stage: 'server-start', message: 'Cannot find web package' };
    artifacts['coverage.json'] = uiCoverage(null, folder, folder, [scenario]);
  } else {
    const raw = {
      ...uiResults([scenario]),
      config: { projects: [{ outputDir: join(folder, 'tests') }] },
    };
    const attempt = raw.suites[0]!.specs[0]!.tests[0]!.results[0]!;
    attempt.status = scenario === 'timeout' ? 'timedOut' : 'failed';
    writeFileSync(join(folder, 'trace.zip'), 'trace fixture bytes');
    attempt.attachments.push({ name: 'trace', path: join(folder, 'trace.zip'), body: '' });
    attempt.attachments.push({
      name: 'before-fault',
      path: undefined,
      body: Buffer.from('screenshot bytes').toString('base64'),
    });
    if (scenario === 'crash')
      attempt.attachments.push({
        name: 'fault-observed',
        path: undefined,
        body: Buffer.from('browser-disconnected').toString('base64'),
      });
    artifacts['results.json'] = raw;
    artifacts['execution.json'] = { scenario, run: artifacts['run.json'] };
    artifacts['coverage.json'] = uiCoverage(raw, folder, folder, [scenario]);
  }
  for (const [name, value] of Object.entries(artifacts))
    writeFileSync(join(folder, name), JSON.stringify(value));
  writeFileSync(
    join(folder, 'command.json'),
    JSON.stringify({
      ...uiIdentity,
      scenario,
      runId: run.id,
      runAttempt: run.attempt,
      exitCode: 1,
      bounded: false,
      temporaryRemoved: true,
      serversStopped: true,
      digests: commandDigests(folder, Object.keys(artifacts)),
    }),
  );
  writeFileSync(
    join(folder, 'report.json'),
    JSON.stringify({
      ...uiIdentity,
      schemaVersion: 1,
      producer: 'ui-diagnostic',
      startedAt: '2026-09-23T00:00:00Z',
      finishedAt: '2026-09-23T00:00:01Z',
      checks: ['source', 'execution', 'coverage', 'cleanup'].map((name) => ({
        id: `ui:${name}`,
        required: true,
        status:
          name === 'source' || name === 'cleanup'
            ? 'pass'
            : name === 'coverage' && scenario === 'startup'
              ? 'unknown'
              : 'fail',
        reason: 'diagnostic fixture',
        evidence: [{ uri: 'command.json', sourceSha: uiIdentity.sourceSha }],
      })),
    }),
  );
}
