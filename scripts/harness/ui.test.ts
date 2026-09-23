import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { readUiEvidence, readUiRun, uiCoverage } from './ui-results.ts';
import { runCommand } from './process.ts';
import { UI_CHECKS, allowedRequest, localOrigin } from '../../e2e/contract.ts';
import { startStaticFixtures } from '../../e2e/static-fixtures.ts';
import { startServers } from '../../e2e/servers.ts';

import { uiResults as results } from './test-support/ui.ts';

describe('UI evidence', () => {
  it('binds relocated artifacts to source and CI attempt and detects removed files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fantasy-ui-relocated-'));
    const info = {
      sourceSha: 'a'.repeat(40),
      candidateSha: 'a'.repeat(40),
      testMergeSha: null,
      baselineSha: null,
    };
    const write = (file: string, value: unknown) =>
      writeFileSync(join(directory, file), JSON.stringify(value));
    try {
      const artifacts = [
        'run.json',
        'runner.log',
        'execution.json',
        'results.json',
        'coverage.json',
        'servers.json',
        'lifecycle.json',
      ];
      const raw = {
        ...results(),
        config: { projects: [{ outputDir: '/original/checkout/ui/tests' }] },
      };
      for (const file of artifacts) write(file, {});
      const runReceipt = { ...info, runId: '10', runAttempt: '2' };
      write('run.json', runReceipt);
      write('execution.json', { run: runReceipt });
      write(
        'lifecycle.json',
        [
          'server-start',
          'api-ready',
          'web-ready',
          'browser',
          'browser-finished',
          'servers-stopped',
        ].map((stage) => ({ stage, at: '2026-09-23T00:00:00Z' })),
      );
      write('results.json', raw);
      write('coverage.json', uiCoverage(raw, directory, '/original/checkout/ui'));
      write('command.json', {
        ...info,
        runId: '10',
        runAttempt: '2',
        scenario: 'smoke',
        exitCode: 0,
        bounded: false,
        temporaryRemoved: true,
        serversStopped: true,
        digests: Object.fromEntries(
          artifacts.map((file) => [
            file,
            createHash('sha256')
              .update(readFileSync(join(directory, file)))
              .digest('hex'),
          ]),
        ),
      });
      write('report.json', {
        ...info,
        schemaVersion: 1,
        producer: 'ui-runner',
        startedAt: '2026-09-23T00:00:00Z',
        finishedAt: '2026-09-23T00:00:01Z',
        checks: UI_CHECKS.map((id) => ({
          id,
          required: true,
          status: 'pass',
          reason: 'fixture',
          evidence: [{ uri: '.generated/harness/ui/command.json', sourceSha: info.sourceSha }],
        })),
      });
      expect(readUiRun(directory, info, { id: '10', attempt: '2' }).producer).toBe('ui-runner');
      expect(() => readUiEvidence(directory, info, { id: '10', attempt: '2' })).toThrow(
        'diagnostic evidence',
      );
      expect(() => readUiRun(directory, info, { id: '10', attempt: '1' })).toThrow('Stale UI');
      expect(() =>
        readUiRun(directory, { ...info, sourceSha: 'b'.repeat(40) }, { id: '10', attempt: '2' }),
      ).toThrow('Stale UI');
      write('execution.json', { changed: true });
      expect(() => readUiRun(directory, info, { id: '10', attempt: '2' })).toThrow(
        'UI execution does not belong',
      );
      rmSync(join(directory, 'results.json'));
      expect(() => readUiRun(directory, info, { id: '10', attempt: '2' })).toThrow(Error);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('requires all actual browser cases and rejects missing/duplicate/skipped executions', () => {
    expect(uiCoverage(results(), '/tmp').status).toBe('pass');
    for (const mutation of ['missing', 'duplicate', 'browser', 'skip', 'retry'] as const) {
      const value = results();
      const specs = value.suites[0]!.specs;
      const attempt = specs[0]!.tests[0]!.results[0]!;
      if (mutation === 'missing') specs.pop();
      if (mutation === 'duplicate') specs.push(specs[0]!);
      if (mutation === 'browser') attempt.attachments = [];
      if (mutation === 'skip') attempt.status = 'skipped';
      if (mutation === 'retry') attempt.retry = 1;
      expect(uiCoverage(value, '/tmp').status).toBe('unknown');
    }
  });
  it('keeps the initial failed attempt and requires its artifact after a passing retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'fantasy-ui-evidence-'));
    try {
      const value = results();
      const attempts = value.suites[0]!.specs[0]!.tests[0]!.results;
      const first = attempts[0]!;
      attempts.push({ ...structuredClone(first), retry: 1 });
      first.status = 'failed';
      first.attachments.push({ name: 'trace', body: '', path: join(root, 'trace.zip') });
      expect(uiCoverage(value, root).status).toBe('unknown');
      writeFileSync(join(root, 'trace.zip'), 'fixture trace bytes');
      const coverage = uiCoverage(value, root);
      expect(coverage.status).toBe('fail');
      expect(coverage.attempts.slice(0, 2).map(({ status, retry }) => [status, retry])).toEqual([
        ['failed', 0],
        ['passed', 1],
      ]);
      expect(coverage.attempts[0]!.attachments[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it('allows only owned HTTP origins, never arbitrary localhost, credentials or external URLs', () => {
  const origins = ['http://127.0.0.1:12345'];
  expect(allowedRequest(`${origins[0]}/api/health`, origins)).toBe(true);
  for (const url of [
    'https://example.com',
    'http://127.0.0.1:3001',
    'http://localhost:12345',
    'file:///tmp/db',
    'http://user:pass@127.0.0.1:12345',
    'ws://127.0.0.1:12345',
  ])
    expect(allowedRequest(url, origins)).toBe(false);
  for (const url of [undefined, 'https://example.com', `${origins[0]}/path`, 'http://127.0.0.1'])
    expect(() => localOrigin(url)).toThrow();
});

it('serves saved fixture bytes on a separate read-only origin without starting API/DB', async () => {
  const server = await startStaticFixtures(process.cwd(), 'http://127.0.0.1:12345');
  try {
    const manifest = await fetch(`${server.origin}/fixtures/manifest.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:12345');
    const chunk = await fetch(`${server.origin}/fixtures/chunk-00000.ndjson.gz`);
    expect(chunk.headers.get('content-type')).toBe('application/gzip');
    expect(chunk.headers.get('content-encoding')).toBeNull();
    expect(Buffer.from(await chunk.arrayBuffer())).toEqual(
      readFileSync('apps/web/test-fixtures/replays/swordsman-sky-mage-240/chunk-00000.ndjson.gz'),
    );
    for (const path of [
      '/api/health',
      '/.env',
      '/fixtures/../.env',
      '/fixtures/manifest.json?other',
    ])
      expect((await fetch(server.origin + path)).status).toBe(404);
    expect(
      (await fetch(`${server.origin}/fixtures/manifest.json`, { method: 'POST' })).status,
    ).toBe(404);
  } finally {
    await server.stop();
  }
});

it.each(['timeout', 'abort'] as const)('kills the owned process group on %s', async (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-ui-process-'));
  try {
    mkdirSync(join(root, 'owned'));
    const marker = join(root, 'owned', 'leaked');
    const parentCode = `
      require('node:child_process').spawn(process.execPath, [
        '-e', "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'leaked'),1500)",
        process.argv[1]
      ], {stdio:'inherit'});
      setInterval(()=>{},1000);
    `;
    const controller = new AbortController();
    const timer = mode === 'abort' ? setTimeout(() => controller.abort(), 100) : null;
    const outcome = await runCommand(process.execPath, ['-e', parentCode, marker], root, {
      timeoutMs: mode === 'timeout' ? 150 : 3000,
      signal: controller.signal,
    });
    if (timer) clearTimeout(timer);
    expect(outcome.bounded).toBe(true);
    expect(outcome.exitCode).not.toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('serves built web assets and isolated API without the dev websocket client', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'fantasy-ui-servers-'));
  let servers: Awaited<ReturnType<typeof startServers>> | undefined;
  try {
    servers = await startServers(process.cwd(), temporary);
    const html = await (await fetch(servers.webOrigin)).text();
    expect(html).not.toMatch(/@vite\/client|@react-refresh|@fs\//);
    const stylesheet = /href="([^"]+\.css)"/.exec(html)?.[1];
    expect(stylesheet).toBeDefined();
    expect(await (await fetch(new URL(stylesheet!, servers.webOrigin))).text()).toContain(
      'Noto Sans JP',
    );
    expect(await (await fetch(`${servers.webOrigin}/api/health`)).json()).toMatchObject({
      status: 'ok',
    });
    expect(servers.webOrigin).not.toBe(servers.apiOrigin);
  } finally {
    await servers?.stop();
    rmSync(temporary, { recursive: true, force: true });
  }
}, 15_000);

it('closes the API when web startup fails after its port is bound', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'fantasy-ui-partial-'));
  const observed: import('../../e2e/servers.ts').ServerState[] = [];
  try {
    await expect(
      startServers(join(temporary, 'missing-web'), temporary, (state) => observed.push(state)),
    ).rejects.toThrow();
    const last = observed.at(-1)!;
    expect(last).toMatchObject({ webOrigin: null, stopped: true });
    expect(last.apiOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(
      fetch(`${last.apiOrigin}/api/health`, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
