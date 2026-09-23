import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vite-plus/test';
import { inspectUiDiagnostics, uiCoverage } from './ui-results.ts';
import { uiResults } from './test-support/ui.ts';

const identity = {
  sourceSha: 'a'.repeat(40),
  candidateSha: 'a'.repeat(40),
  baselineSha: null,
  testMergeSha: null,
};
const run = { id: '10', attempt: '1' };

function probe(root: string, scenario: 'startup' | 'timeout' | 'crash') {
  const folder = join(root, 'diagnostics', scenario);
  mkdirSync(folder, { recursive: true });
  const artifacts: Record<string, unknown> = {
    'run.json': { ...identity, runId: run.id, runAttempt: run.attempt },
    'runner.log': 'expected failure log',
    'lifecycle.json': [{ stage: 'api-ready' }, { stage: 'servers-stopped' }],
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
      ...identity,
      scenario,
      runId: run.id,
      runAttempt: run.attempt,
      exitCode: 1,
      bounded: false,
      temporaryRemoved: true,
      serversStopped: true,
      digests: Object.fromEntries(
        Object.keys(artifacts).map((file) => [
          file,
          createHash('sha256')
            .update(readFileSync(join(folder, file)))
            .digest('hex'),
        ]),
      ),
    }),
  );
  writeFileSync(
    join(folder, 'report.json'),
    JSON.stringify({
      ...identity,
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
        evidence: [{ uri: 'command.json', sourceSha: identity.sourceSha }],
      })),
    }),
  );
}

it('requires all fault types, actual failure outcomes, retained artifacts and the current CI attempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-ui-diagnostics-'));
  try {
    for (const scenario of ['startup', 'timeout', 'crash'] as const) probe(root, scenario);
    expect(inspectUiDiagnostics(root, identity, run).status).toBe('pass');
    expect(inspectUiDiagnostics(root, identity, { ...run, attempt: '2' }).status).toBe('unknown');
    for (const [file, field, value] of [
      ['command.json', 'exitCode', 0],
      ['command.json', 'temporaryRemoved', false],
      ['command.json', 'scenario', 'smoke'],
      ['report.json', 'producer', 'ui-runner'],
    ] as const) {
      const path = join(root, 'diagnostics/crash', file);
      const original = readFileSync(path, 'utf8');
      const data = JSON.parse(original) as Record<string, unknown>;
      data[field] = value;
      writeFileSync(path, JSON.stringify(data));
      expect(inspectUiDiagnostics(root, identity, run).status).toBe('unknown');
      writeFileSync(path, original);
    }
    rmSync(join(root, 'diagnostics/timeout/trace.zip'));
    expect(inspectUiDiagnostics(root, identity, run).status).toBe('unknown');
    rmSync(join(root, 'diagnostics/startup'), { recursive: true });
    expect(inspectUiDiagnostics(root, identity, run).status).toBe('unknown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
