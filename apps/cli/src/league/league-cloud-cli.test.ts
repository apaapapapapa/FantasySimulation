import { readFile, mkdir, writeFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { withReplayDirectory } from '@fantasy/api/testing';

const operations = vi.hoisted(() => ({
  source: vi.fn(),
  probe: vi.fn(),
  prepare: vi.fn(),
  run: vi.fn(),
  finish: vi.fn(),
  transfer: vi.fn(),
}));
vi.mock('./league-probe.ts', () => ({ probeLeague: operations.probe }));
vi.mock('./league-cloud.ts', () => ({
  prepareCloudLeague: operations.prepare,
  runCloudLeague: operations.run,
  finishCloudLeague: operations.finish,
}));
vi.mock('./league-transfer.ts', () => ({ transferCloudLeague: operations.transfer }));
const originalArgv = process.argv,
  originalExitCode = process.exitCode;
const secret = 'CLI_PRIVATE_SENTINEL';
beforeEach(() => {
  vi.resetModules();
  vi.doMock('@fantasy/api/tooling', async (original) => ({
    ...(await original<typeof import('@fantasy/api/tooling')>()),
    executionSource: operations.source,
  }));
  for (const operation of Object.values(operations)) operation.mockReset();
  operations.source.mockReturnValue({
    sha: 'a'.repeat(40),
    node: '24.19.0',
    platform: 'linux',
    arch: 'x64',
  });
  for (const [key, value] of Object.entries({
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    PUBLICATION_WORKER_URL: 'https://reader.example/',
    PUBLICATION_VIEWER_URL: 'https://viewer.example/',
    R2_ACCOUNT_ID: secret,
    R2_BUCKET: secret,
    R2_ACCESS_KEY_ID: secret,
    R2_SECRET_ACCESS_KEY: secret,
  }))
    vi.stubEnv(key, value);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function invoke(root: string, command: string) {
  vi.stubEnv('GITHUB_STEP_SUMMARY', join(root, 'summary.md'));
  vi.stubEnv('GITHUB_OUTPUT', join(root, 'output.txt'));
  process.argv = ['node', 'league-cloud.ts', command, root, 'data/leagues/official-20-v1.json'];
  await import('../league-cloud.ts');
  return process.exitCode ?? 0;
}

it.each([
  ['probe', 'INPUT_INVALID', 'planning'],
  ['run', 'IDENTITY_MISMATCH', 'execution'],
  ['restore', 'DATA_INVALID', 'restoration'],
  ['admit', 'BUDGET_EXCEEDED', 'publication'],
  ['finish', 'UNKNOWN', 'validation'],
  ['publish', 'PUBLICATION_COMMIT_UNKNOWN', 'publication'],
] as const)(
  'keeps exit 1 and a safe report/Summary for %s failure',
  async (command, code, phase) => {
    const { OperationError } = await import('@fantasy/api/tooling');
    const { PublicationFailure } = await import('../publication/publication-remote.ts');
    const privateError = new Error(`https://private/${secret}?token=${secret}`, {
      cause: new Error(secret),
    });
    const error =
      code === 'UNKNOWN'
        ? privateError
        : code === 'PUBLICATION_COMMIT_UNKNOWN'
          ? new PublicationFailure('commit-unknown', privateError)
          : new OperationError(code, secret, secret);
    const operation =
      command === 'admit' || command === 'restore' || command === 'publish'
        ? operations.transfer
        : operations[command];
    operation.mockRejectedValue(error);
    await withReplayDirectory(async (root) => {
      expect(await invoke(root, command)).toBe(1);
      expect(operation).toHaveBeenCalledOnce();
      const text = await readFile(join(root, 'reports', `failure-${command}.json`), 'utf8');
      expect(JSON.parse(text)).toMatchObject({ code, phase, status: 'failed' });
      const summary = await readFile(join(root, 'summary.md'), 'utf8');
      expect(summary).toContain(code);
      expect(summary).toContain('Next action:');
      expect(text + summary + vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain(
        secret,
      );
    });
  },
);

it.each([true, false])(
  'preserves successful versus incomplete partition output without fabricating draws (complete=%s)',
  async (complete) => {
    operations.run.mockResolvedValue({
      complete,
      elapsedMs: 10,
      resultId: `sha256:${'b'.repeat(64)}`,
    });
    await withReplayDirectory(async (root) => {
      expect(await invoke(root, 'run')).toBe(0);
      expect(console.log).toHaveBeenCalledWith(expect.objectContaining({ complete }));
      expect(console.error).not.toHaveBeenCalled();
    });
  },
);

it('retains failure when JSON and Summary cannot be written', async () => {
  operations.run.mockRejectedValue(new Error(secret));
  await withReplayDirectory(async (root) => {
    await mkdir(join(root, 'summary.md'));
    await mkdir(join(root, 'reports/failure-run.json'), { recursive: true });
    expect(await invoke(root, 'run')).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('LEAGUE_REPORT_WRITE_FAILED'),
    );
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain(secret);
  });
});

it.each(['{', '{}'])(
  'identifies malformed retained probe metadata (%s) through the real transport and parser',
  async (data) => {
    const actual = await vi.importActual<typeof import('./league-probe.ts')>('./league-probe.ts');
    operations.probe.mockImplementation(actual.probeLeague);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(data, { headers: { 'content-type': 'application/json' } }),
    );
    await withReplayDirectory(async (root) => {
      expect(await invoke(root, 'probe')).toBe(1);
      expect(
        JSON.parse(await readFile(join(root, 'reports/failure-probe.json'), 'utf8')),
      ).toMatchObject({ code: 'DATA_INVALID' });
      expect(await readFile(join(root, 'summary.md'), 'utf8')).toContain(
        'Saved data failed validation',
      );
    });
  },
);

it.each(['json', 'size'])('classifies invalid committed definition %s as input', async (kind) => {
  const files = await import('./league-cloud-files.ts'),
    readJson = files.cloudJson;
  await withReplayDirectory(async (root) => {
    await writeFile(join(root, 'invalid-definition.json'), `{${secret}`);
    if (kind === 'size') await truncate(join(root, 'invalid-definition.json'), 16000001);
    vi.spyOn(files, 'cloudJson').mockImplementation((_path, ref, code) =>
      readJson(join(root, 'invalid-definition.json'), ref, code),
    );
    expect(await invoke(root, 'probe')).toBe(1);
    expect(operations.probe).not.toHaveBeenCalled();
    const report = await readFile(join(root, 'reports/failure-probe.json'), 'utf8');
    expect(JSON.parse(report)).toMatchObject({ code: 'INPUT_INVALID' });
    const summary = await readFile(join(root, 'summary.md'), 'utf8');
    expect(summary).toContain('Correct the committed input');
    expect(report + summary).not.toContain(secret);
  });
});

it.each([`{${secret}`, JSON.stringify({ result: { outcome: secret } })])(
  'identifies a malformed retained receipt during real preparation',
  async (data) => {
    const actual = await vi.importActual<typeof import('./league-cloud.ts')>('./league-cloud.ts');
    const { publicationFixture } = await import('../../test-support/publication.ts');
    const { exportPublication } = await import('../publication/publication-export.ts');
    operations.prepare.mockImplementation(actual.prepareCloudLeague);
    await withReplayDirectory(async (root) => {
      const fixture = await publicationFixture(join(root, 'fixture'));
      await exportPublication(fixture.plan, [fixture], join(root, 'public'));
      await writeFile(
        join(root, 'public', 'objects', fixture.receipt.objectHash.slice(7), 'receipt.json'),
        data,
      );
      await writeFile(
        join(root, 'inventory.json'),
        JSON.stringify({
          files: 1,
          bytes: 1,
          receipts: 1,
          usedReadRequests: 0,
          usedWriteRequests: 0,
        }),
      );
      expect(await invoke(root, 'prepare')).toBe(1);
      const report = await readFile(join(root, 'reports/failure-prepare.json'), 'utf8');
      expect(JSON.parse(report)).toMatchObject({ code: 'DATA_INVALID', phase: 'planning' });
      const summary = await readFile(join(root, 'summary.md'), 'utf8');
      expect(summary).toContain('Saved data failed validation');
      expect(report + summary + vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain(
        secret,
      );
    });
  },
);

it.each([
  ['GITHUB_RUN_ID', `123\n${secret}`],
  ['GITHUB_RUN_ATTEMPT', '1\n'],
  ['GITHUB_RUN_ATTEMPT', '1\u2028'],
])('rejects invalid Actions identity before execution (%s)', async (key, value) => {
  vi.stubEnv(key, value);
  await withReplayDirectory(async (root) => {
    expect(await invoke(root, 'run')).toBe(1);
    expect(operations.run).not.toHaveBeenCalled();
    const text = await readFile(join(root, 'reports/failure-run.json'), 'utf8');
    expect(JSON.parse(text)).toMatchObject({ code: 'INPUT_INVALID', phase: 'validation' });
    expect(text + (await readFile(join(root, 'summary.md'), 'utf8'))).not.toContain(secret);
  });
});
