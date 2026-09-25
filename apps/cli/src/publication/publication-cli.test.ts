import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { publicationFixture } from '../../test-support/publication.ts';

const transport = vi.hoisted(() => ({ publish: vi.fn(), restore: vi.fn(), opened: vi.fn() }));
vi.mock('./publication-restore.ts', () => ({ restorePublication: transport.restore }));
vi.mock('./publication-remote.ts', async (original) => ({
  ...(await original<typeof import('./publication-remote.ts')>()),
  publishPublication: transport.publish,
}));
vi.mock('./publication-s3.ts', () => ({
  PublicationS3: class {
    constructor(...args: unknown[]) {
      transport.opened(...args);
    }
    metrics() {
      return {};
    }
    close() {}
  },
}));
const roots: string[] = [];
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  transport.publish.mockReset();
  transport.restore.mockReset();
  transport.opened.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const name of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'])
    vi.stubEnv(name, 'fixture-only');
  vi.stubEnv('PUBLICATION_VIEWER_URL', 'https://viewer.example/');
  vi.stubEnv('PUBLICATION_WORKER_URL', 'https://reader.example/');
  process.exitCode = undefined;
});
afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function run(kind: 'complete' | 'truncated', flags: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'publication-cli-'));
  roots.push(root);
  const bundles = join(root, 'batch');
  const fixture = await publicationFixture(bundles, kind);
  const plan = join(root, 'plan.json');
  const index = join(root, 'index.json');
  await writeFile(plan, JSON.stringify(fixture.plan));
  await writeFile(index, JSON.stringify(fixture.index));
  process.argv = ['node', 'publication.ts', 'publish', plan, join(root, 'public'), index];
  process.argv.push(bundles, ...flags);
  await import('../publication.ts');
  return process.exitCode ?? 0;
}

it.each([false, true])('accepts historical partial rows (dry run: %s)', async (dry) => {
  const status = dry ? 'planned' : 'verified';
  transport.publish.mockResolvedValue({ status, incompleteRows: 1 });
  const flags = ['--require-complete-input', ...(dry ? ['--dry-run'] : [])];
  expect(await run('complete', flags)).toBe(0);
  expect(transport.publish).toHaveBeenCalledOnce();
  expect(console.log).toHaveBeenCalledWith(JSON.stringify({ incompleteRows: 1, status }));
});
it('retains the existing CLI exit code when complete-input mode is absent', async () => {
  transport.publish.mockResolvedValue({ status: 'verified', incompleteRows: 1 });
  expect(await run('complete', [])).toBe(2);
});
it('rejects an incomplete current batch before constructing the remote client', async () => {
  expect(await run('truncated', ['--require-complete-input'])).toBe(1);
  expect(transport.opened).not.toHaveBeenCalled();
  expect(transport.publish).not.toHaveBeenCalled();
});
it('never treats a remote verification failure as success in complete-input mode', async () => {
  transport.publish.mockRejectedValue(new Error('fixture read-back failure'));
  expect(await run('complete', ['--require-complete-input'])).toBe(1);
});
it('reports a verified pre-exported league upload as success while preserving provisional counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'league-upload-'));
  roots.push(root);
  transport.publish.mockResolvedValue({ status: 'verified', incompleteRows: 4 });
  process.argv = ['node', 'publication.ts', 'upload', join(root, 'public')];
  await import('../publication.ts');
  expect(process.exitCode ?? 0).toBe(0);
  expect(transport.publish).toHaveBeenCalledOnce();
  expect(console.log).toHaveBeenCalledWith(
    JSON.stringify({ incompleteRows: 4, status: 'verified' }),
  );
});

it.each(['upload', 'restore'])(
  'forwards explicit league transfer to %s and its S3 transport',
  async (command) => {
    const root = await mkdtemp(join(tmpdir(), 'league-transfer-cli-'));
    roots.push(root);
    transport.publish.mockResolvedValue({ status: 'verified', incompleteRows: 0 });
    transport.restore.mockResolvedValue({ status: 'restored' });
    process.argv = ['node', 'publication.ts', command, join(root, 'public'), '--league-transfer'];
    await import('../publication.ts');
    expect(process.exitCode ?? 0).toBe(0);
    expect(transport.opened.mock.calls[0]![1]).toEqual({
      maxRequests: 2000000,
      maxClassARequests: 900000,
      maxClassBRequests: 2000000,
      deadlineMs: 3600000,
      maxAttempts: 1,
    });
    if (command === 'restore') {
      expect(transport.restore.mock.calls[0]!.slice(2)).toEqual([8000000000, 16]);
    } else {
      expect(transport.publish.mock.calls[0]![2]).toMatchObject({
        maxWrites: 500000,
        maxTransferBytes: 8000000000,
        maxWorkerRequests: 1000,
        concurrency: 16,
      });
    }
  },
);
