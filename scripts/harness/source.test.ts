import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vite-plus/test';
import { artifactDirectory, collectSource, sourceIdentity } from './source.ts';
import { redact, runCommand, safeEnvironment } from './process.ts';
import { testRepository as repository } from './test-support/repository.ts';

const passed = { exitCode: 0, signal: null, output: 'passed\n', bounded: false };
describe('source evidence collection', () => {
  it(
    'records a real source identity and the fixed command without recursively verifying tests',
    { timeout: 15000 },
    async () => {
      const repo = repository();
      try {
        const result = await collectSource(
          repo.root,
          '.generated/harness/success',
          async (cmd, args) => {
            assert.equal(cmd, 'vp');
            assert.deepEqual(args, ['run', 'verify']);
            return passed;
          },
          {},
        );
        assert.equal(result.exitCode, 0);
        const receipt = JSON.parse(
          readFileSync(join(repo.root, '.generated/harness/success/command.json'), 'utf8'),
        ) as Record<string, unknown>;
        assert.equal(receipt.sourceSha, repo.git('rev-parse', 'HEAD').trim());
        assert.equal(receipt.cleanAfter, true);
      } finally {
        repo.dispose();
      }
    },
  );
  it(
    'rejects a repository subdirectory before executing verification',
    { timeout: 15000 },
    async () => {
      const repo = repository();
      try {
        const nested = join(repo.root, 'nested');
        mkdirSync(nested);
        await assert.rejects(
          collectSource(
            nested,
            '.generated/harness/nested',
            async () => {
              assert.fail('A nested directory must not execute verification');
            },
            {},
          ),
          /repository root/,
        );
      } finally {
        repo.dispose();
      }
    },
  );
  it('does not execute against dirty or untracked source', { timeout: 15000 }, async () => {
    const repo = repository();
    try {
      writeFileSync(join(repo.root, 'untracked.ts'), 'export {};');
      const result = await collectSource(
        repo.root,
        '.generated/harness/dirty',
        async () => {
          assert.fail('Dirty source must not execute');
        },
        {},
      );
      assert.equal(result.exitCode, 1);
      assert.equal(result.report.checks[1]!.status, 'unknown');
    } finally {
      repo.dispose();
    }
  });
  it(
    'fails if the command changes the source, exits unsuccessfully or exceeds its budget',
    { timeout: 15000 },
    async () => {
      for (const mode of ['mutation', 'exit', 'budget']) {
        const repo = repository();
        try {
          const result = await collectSource(
            repo.root,
            '.generated/harness/fail',
            async () => {
              if (mode === 'mutation') writeFileSync(join(repo.root, 'source.txt'), 'changed');
              return { ...passed, exitCode: mode === 'exit' ? 1 : 0, bounded: mode === 'budget' };
            },
            {},
          );
          assert.equal(result.exitCode, 1);
        } finally {
          repo.dispose();
        }
      }
    },
  );
  it('refuses stale CI identity and unsafe or reused evidence paths', { timeout: 15000 }, () => {
    const repo = repository();
    try {
      assert.throws(() => sourceIdentity(repo.root, { GITHUB_SHA: 'a'.repeat(40) }));
      assert.throws(() => sourceIdentity(repo.root, { GITHUB_EVENT_NAME: 'pull_request' }));
      assert.throws(() => artifactDirectory(repo.root, '../outside'));
      assert.throws(() => artifactDirectory(repo.root, '.generated/harness/../outside'));
      artifactDirectory(repo.root, '.generated/harness/once');
      assert.throws(() => artifactDirectory(repo.root, '.generated/harness/once'));
      symlinkSync(
        repo.root,
        join(repo.root, '.generated/harness/link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      assert.throws(() => artifactDirectory(repo.root, '.generated/harness/link/escape'));
    } finally {
      repo.dispose();
    }
  });
});
describe('bounded execution', () => {
  it('captures success, failure and spawn errors', async () => {
    assert.equal(
      (await runCommand(process.execPath, ['-e', 'console.log("ok")'], tmpdir())).exitCode,
      0,
    );
    assert.equal(
      (await runCommand(process.execPath, ['-e', 'process.exit(3)'], tmpdir())).exitCode,
      3,
    );
    assert.notEqual((await runCommand('fantasy-nonexistent-command', [], tmpdir())).exitCode, 0);
  });
  it('terminates over-time and over-output commands', async () => {
    const timed = await runCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 100)'],
      tmpdir(),
      { timeoutMs: 200 },
    );
    assert.equal(timed.bounded, true);
    const large = await runCommand(
      process.execPath,
      ['-e', 'console.log("x".repeat(10000))'],
      tmpdir(),
      { maxBytes: 100 },
    );
    assert.equal(large.bounded, true);
    assert.ok(Buffer.byteLength(large.output) <= 100);
  });
  it('does not forward secrets or execution-injection environment variables', () => {
    assert.deepEqual(
      safeEnvironment({
        PATH: '/tools',
        GH_TOKEN: 'secret-value',
        NODE_OPTIONS: '--import evil',
        CI: 'true',
      }),
      { PATH: '/tools', CI: 'true' },
    );
    assert.equal(
      redact('secret-value ghp_abcdefgh', { GH_TOKEN: 'secret-value' }),
      '[REDACTED] [REDACTED]',
    );
  });
});
