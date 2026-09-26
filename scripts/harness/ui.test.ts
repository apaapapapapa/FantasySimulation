import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { inspectUiStatic, readUiEvidence, readUiRun, uiCoverage } from './ui-results.ts';
import { runCommand } from './process.ts';
import { assessReport, type Report } from './report.ts';
import {
  UI_CHECKS,
  UI_FAULTS,
  UI_MATRIX_JOB,
  UI_PARTS,
  UI_RUN_CHECKS,
  UI_STATIC_CASES,
  UI_STATIC_SCENARIOS,
  uiBrowsers,
  uiCaseGrep,
  uiCases,
  uiSettings,
  allowedRequest,
  localOrigin,
  type UiScenario,
} from '../../e2e/contract.ts';
import { startStaticFixtures } from '../../e2e/static-fixtures.ts';
import { startServers } from '../../e2e/servers.ts';
import { publicFixtures } from '../../e2e/publication-fixtures.ts';

import { uiIdentity, uiResults as results, writeUiProbe, writeUiRun } from './test-support/ui.ts';

const relocatedRun = { id: '10', attempt: '2' };
function withUiRoot(prefix: string, check: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const writeStaticParts = (root: string) => {
  for (const part of UI_STATIC_SCENARIOS)
    writeUiRun(join(root, 'static', part), part, relocatedRun);
};

/** Rejects another attempt or source, a changed execution receipt and a removed raw result. */
function expectRunBinding(directory: string, scenario: UiScenario) {
  expect(() => readUiRun(directory, uiIdentity, { id: '10', attempt: '1' }, scenario)).toThrow(
    'Stale UI',
  );
  expect(() =>
    readUiRun(directory, { ...uiIdentity, sourceSha: 'b'.repeat(40) }, relocatedRun, scenario),
  ).toThrow('Stale UI');
  const execution = readFileSync(join(directory, 'execution.json'));
  writeFileSync(join(directory, 'execution.json'), JSON.stringify({ changed: true }));
  expect(() => readUiRun(directory, uiIdentity, relocatedRun, scenario)).toThrow(
    'UI execution does not belong',
  );
  writeFileSync(join(directory, 'execution.json'), execution);
  expect(readUiRun(directory, uiIdentity, relocatedRun, scenario).producer).toBeTruthy();
  rmSync(join(directory, 'results.json'));
  expect(() => readUiRun(directory, uiIdentity, relocatedRun, scenario)).toThrow('ENOENT');
}

describe('UI evidence', () => {
  it('binds relocated editor/battle artifacts to source and CI attempt and detects removed files', () =>
    withUiRoot('fantasy-ui-relocated-', (root) => {
      writeUiRun(root, 'smoke', relocatedRun, UI_CHECKS);
      expect(readUiRun(root, uiIdentity, relocatedRun, 'smoke').producer).toBe('ui-runner');
      expect(() => readUiEvidence(root, uiIdentity, relocatedRun)).toThrow('diagnostic evidence');
      expectRunBinding(root, 'smoke');
    }));
  it.each(UI_STATIC_SCENARIOS)(
    'binds relocated %s artifacts to source and CI attempt and detects removed files',
    (part) =>
      withUiRoot('fantasy-ui-relocated-', (root) => {
        writeStaticParts(root);
        const directory = join(root, 'static', part);
        expect(readUiRun(directory, uiIdentity, relocatedRun, part).producer).toBe('ui-static');
        expect(inspectUiStatic(root, uiIdentity, relocatedRun).status).toBe('pass');
        expect(inspectUiStatic(root, uiIdentity, { id: '10', attempt: '3' }).status).toBe(
          'unknown',
        );
        expectRunBinding(directory, part);
        expect(inspectUiStatic(root, uiIdentity, relocatedRun).status).toBe('unknown');
      }),
  );
  it('recombines separately collected static parts and recomputes the static result', () =>
    withUiRoot('fantasy-ui-parts-', (root) => {
      // CI's interactive part reports its suite and fault probes; static parts arrive separately.
      writeUiRun(root, 'smoke', relocatedRun, [...UI_RUN_CHECKS, 'ui:diagnostics']);
      for (const fault of UI_FAULTS) writeUiProbe(root, fault, relocatedRun);
      writeStaticParts(root);
      const report = readUiEvidence(root, uiIdentity, relocatedRun);
      expect(assessReport(report, UI_CHECKS).exitCode).toBe(0);
      expect(
        report.checks.find((check) => check.id === 'ui:static-replay')?.evidence.map((e) => e.uri),
      ).toEqual(
        UI_STATIC_SCENARIOS.map((part) => `.generated/harness/ui/static/${part}/command.json`),
      );
      // A local run of every suite may claim the static result, but never a contradicting one.
      const claimed = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')) as Report;
      const withClaim = (status: string) =>
        writeFileSync(
          join(root, 'report.json'),
          JSON.stringify({
            ...claimed,
            checks: [...claimed.checks, { ...claimed.checks[0]!, id: 'ui:static-replay', status }],
          }),
        );
      withClaim('pass');
      expect(readUiEvidence(root, uiIdentity, relocatedRun).checks).toHaveLength(
        claimed.checks.length + 1,
      );
      withClaim('fail');
      expect(() => readUiEvidence(root, uiIdentity, relocatedRun)).toThrow('static UI evidence');
      writeFileSync(join(root, 'report.json'), JSON.stringify(claimed));
      // Each part must cover exactly its own cases in its own browser.
      writeUiRun(join(root, 'static', 'static-webkit-2'), 'static-webkit-1', relocatedRun);
      expect(() => readUiEvidence(root, uiIdentity, relocatedRun)).toThrow('static UI evidence');
      rmSync(join(root, 'static', 'static-webkit-2'), { recursive: true });
      expect(() => readUiEvidence(root, uiIdentity, relocatedRun)).toThrow('static UI evidence');
    }));
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
  it('assigns every static case in both browsers to exactly one part', () => {
    const pairs = UI_STATIC_SCENARIOS.flatMap((part) =>
      uiCases(part).map((id) => `${id}:${uiBrowsers(part).join()}`),
    );
    expect(pairs.toSorted()).toEqual(
      UI_STATIC_CASES.flatMap((id) => [`${id}:chromium`, `${id}:webkit`]).toSorted(),
    );
    for (const part of UI_STATIC_SCENARIOS) {
      expect(uiBrowsers(part)).toHaveLength(1);
      expect(uiSettings(part).browsers).toEqual(uiBrowsers(part));
    }
    // Playwright matches `project file describe title`; similar prefixes must not select a case.
    const grep = uiCaseGrep(['static-selection', 'static-network-boundary']);
    expect(grep.test('webkit viewer.spec.ts static-selection')).toBe(true);
    expect(grep.test('webkit viewer.spec.ts static origin guard static-network-boundary')).toBe(
      true,
    );
    expect(grep.test('webkit selection.spec.ts static-selection-original')).toBe(false);
    expect(grep.test('webkit viewer.spec.ts static-selection-invalid-link')).toBe(false);
  });
  it('requires every case of a static part in its browser, including real browser identities', () => {
    for (const part of UI_STATIC_SCENARIOS) {
      const cases = uiCases(part);
      const browsers = uiBrowsers(part);
      const raw = results(cases, browsers);
      expect(uiCoverage(raw, '/tmp', '/tmp', cases, browsers).status).toBe('pass');
      const duplicated = structuredClone(raw);
      duplicated.suites[0]!.specs.push(duplicated.suites[0]!.specs[1]!);
      expect(uiCoverage(duplicated, '/tmp', '/tmp', cases, browsers).status).toBe('unknown');
      raw.suites[0]!.specs.pop();
      expect(uiCoverage(raw, '/tmp', '/tmp', cases, browsers).status).toBe('unknown');
      const other = browsers[0] === 'webkit' ? 'chromium' : 'webkit';
      expect(uiCoverage(results(cases, [other]), '/tmp', '/tmp', cases, browsers).status).toBe(
        'unknown',
      );
      const spoofed = results(cases, browsers);
      spoofed.suites[0]!.specs[1]!.tests[0]!.results[0]!.attachments[0]!.body = Buffer.from(
        JSON.stringify({ name: other, version: '123.0' }),
      ).toString('base64');
      expect(uiCoverage(spoofed, '/tmp', '/tmp', cases, browsers).status).toBe('unknown');
    }
  });
  it('runs one CI browser job per part and gathers only this attempt', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain(`        part: [${UI_PARTS.join(', ')}]`);
    expect(workflow).toContain(`    name: ${UI_MATRIX_JOB}`);
    expect(workflow).toContain(
      'pattern: harness-ui-*-${{ github.run_id }}-${{ github.run_attempt }}',
    );
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
  const server = await startStaticFixtures(process.cwd(), () => 'http://127.0.0.1:12345');
  try {
    const files = publicFixtures(process.cwd());
    const key = [...files.keys()].find((key) => key.endsWith('/chunk-00000.ndjson.gz'))!;
    const manifest = await fetch(`${server.origin}/fixtures/catalog/current.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:12345');
    const chunk = await fetch(`${server.origin}/fixtures/${key}`);
    expect(chunk.headers.get('content-type')).toBe('application/gzip');
    expect(chunk.headers.get('content-encoding')).toBeNull();
    expect(Buffer.from(await chunk.arrayBuffer())).toEqual(files.get(key));
    for (const path of [
      '/api/health',
      '/.env',
      '/fixtures/../.env',
      '/fixtures/catalog/current.json?other',
    ])
      expect((await fetch(server.origin + path)).status).toBe(404);
    expect(
      (await fetch(`${server.origin}/fixtures/catalog/current.json`, { method: 'POST' })).status,
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
