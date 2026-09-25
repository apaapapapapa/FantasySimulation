import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { testRepository } from '../test-support/repository.ts';
import { DEFAULT_BUDGET } from './contract.ts';
import { initialize, readJournal } from './journal.ts';
import { status } from './state.ts';
import {
  applyPatch,
  beginAttempt,
  copyDependencies,
  locations,
  owned,
  prepare,
  recover,
} from './workspace.ts';
import { evaluate, isolatedCommand, sandboxCommand, writableOutputs } from './evaluation.ts';

function fixture() {
  const repo = testRepository({
    'src/value.ts': 'export const value = 0;\n',
    'src/value.test.ts': 'old acceptance\n',
    '.gitignore': '.generated/\nnode_modules/\n**/dist/\n',
  });
  repo.git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  const store = mkdtempSync(join(tmpdir(), 'fantasy-loop-workspace-'));
  const baselineSha = repo.git('rev-parse', 'HEAD').trim();
  const path = initialize(store, {
    schemaVersion: 1,
    repository: 'owner/repo',
    baselineSha,
    goal: 'Repair value',
    allowedPaths: ['src'],
    requiredChecks: ['source-clean', 'source-verify'],
    budget: DEFAULT_BUDGET,
    review: 'self',
    reviewWaitMs: 0,
    target: 'pr',
  });
  const patch = join(store, 'proposal.diff');
  const proposal = (content: string) => {
    writeFileSync(patch, content);
    const view = status(readJournal(path));
    return { patch, baseSha: view.candidateSha, attempt: view.attempts };
  };
  return {
    repo,
    store,
    path,
    baselineSha,
    proposal,
    dispose: () => {
      repo.dispose();
      rmSync(store, { recursive: true, force: true });
    },
  };
}
const change = (name = 'src/value.ts') =>
  `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-export const value = 0;\n+export const value = 1;\n`;
const reservation = { hypothesis: 'Value must be one', externalCalls: 1, costMicros: 0 };
it('copies package-local dependency links into the isolated workspace', () => {
  const f = fixture();
  try {
    const modules = join(f.repo.root, 'node_modules/shared');
    mkdirSync(modules, { recursive: true });
    writeFileSync(join(modules, 'value'), 'original');
    for (const prefix of ['apps/cli', 'apps/replay-reader', 'packages/samples']) {
      mkdirSync(join(f.repo.root, prefix, 'node_modules'), { recursive: true });
      symlinkSync('../../../node_modules/shared', join(f.repo.root, prefix, 'node_modules/shared'));
    }
    const target = join(f.store, 'candidate');
    copyDependencies(f.repo.root, target);
    writeFileSync(join(target, 'node_modules/shared/value'), 'candidate');
    for (const prefix of ['apps/cli', 'apps/replay-reader', 'packages/samples'])
      expect(readFileSync(join(target, prefix, 'node_modules/shared/value'), 'utf8')).toBe(
        'candidate',
      );
    expect(readFileSync(join(modules, 'value'), 'utf8')).toBe('original');
  } finally {
    f.dispose();
  }
});
describe('owned workspace and full baseline scope', () => {
  it('keeps the original clean, commits only allowed changes, and deduplicates the patch', async () => {
    const f = fixture();
    try {
      await prepare(f.path, f.repo.root);
      await beginAttempt(f.path, reservation);
      const p = f.proposal(change());
      const applied = await applyPatch(f.path, p);
      expect(applied.candidateSha).not.toBe(f.baselineSha);
      expect((await applyPatch(f.path, p)).attempts).toBe(1);
      expect(readFileSync(join(locations(f.path).workspace, 'src/value.ts'), 'utf8')).toContain(
        '= 1',
      );
      expect(f.repo.git('status', '--porcelain')).toBe('');
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.baselineSha);
      expect(readFileSync(join(f.repo.root, 'src/value.ts'), 'utf8')).toContain('= 0');
    } finally {
      f.dispose();
    }
  });
  it.each(['protected', 'symlink', 'mode', 'old-test'])(
    'rejects %s and retains the attempt reservation',
    async (kind) => {
      const f = fixture();
      try {
        await prepare(f.path, f.repo.root);
        await beginAttempt(f.path, reservation);
        const patches = {
          protected:
            'diff --git a/AGENTS.md b/AGENTS.md\nnew file mode 100644\n--- /dev/null\n+++ b/AGENTS.md\n@@ -0,0 +1 @@\n+override\n',
          symlink:
            'diff --git a/src/link b/src/link\nnew file mode 120000\n--- /dev/null\n+++ b/src/link\n@@ -0,0 +1 @@\n+/tmp\n',
          mode: 'diff --git a/src/value.ts b/src/value.ts\nold mode 100644\nnew mode 100755\n',
          'old-test':
            'diff --git a/src/value.test.ts b/src/value.test.ts\n--- a/src/value.test.ts\n+++ b/src/value.test.ts\n@@ -1 +1 @@\n-old acceptance\n+weaker acceptance\n',
        };
        await expect(
          applyPatch(f.path, f.proposal(patches[kind as keyof typeof patches])),
        ).rejects.toThrow();
        expect(status(readJournal(f.path))).toMatchObject({
          attempts: 1,
          externalCalls: 1,
          candidateSha: f.baselineSha,
        });
        owned(f.path);
      } finally {
        f.dispose();
      }
    },
  );
  it('rejects dirty, wrong-repository, wrong-branch and stale inputs', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo.root, 'dirty'), 'x');
      await expect(prepare(f.path, f.repo.root)).rejects.toThrow(/Dirty/);
      rmSync(join(f.repo.root, 'dirty'));
      f.repo.git('remote', 'set-url', 'origin', 'https://github.com/other/repo.git');
      await expect(prepare(f.path, f.repo.root)).rejects.toThrow(/repository/);
      f.repo.git('remote', 'set-url', 'origin', 'https://github.com/owner/repo.git');
      await prepare(f.path, f.repo.root);
      await beginAttempt(f.path, reservation);
      const p = { ...f.proposal(change()), baseSha: 'f'.repeat(40) };
      await expect(applyPatch(f.path, p)).rejects.toThrow(/Stale/);
      const { workspace } = locations(f.path);
      f.repo.git('-C', workspace, 'checkout', '-b', 'unexpected');
      expect(() => owned(f.path)).toThrow(/branch/);
    } finally {
      f.dispose();
    }
  });
  it('recovers interrupted work without a refund', async () => {
    const f = fixture();
    try {
      await prepare(f.path, f.repo.root);
      await beginAttempt(f.path, reservation);
      writeFileSync(join(locations(f.path).workspace, 'src/value.ts'), 'interrupted edit');
      const result = await recover(f.path, 'Operator confirmed process ended');
      expect(result).toMatchObject({
        attempts: 1,
        externalCalls: 1,
        noProgress: 1,
        phase: 'ready',
      });
      owned(f.path);
    } finally {
      f.dispose();
    }
  });
  it('owns every Git object even when the source borrows objects from another checkout', async () => {
    const f = fixture();
    try {
      const borrowed = join(f.store, 'borrowed');
      f.repo.git('clone', '--shared', f.repo.root, borrowed);
      f.repo.git(
        '-C',
        borrowed,
        'remote',
        'set-url',
        'origin',
        'https://github.com/owner/repo.git',
      );
      await prepare(f.path, borrowed);
      rmSync(borrowed, { recursive: true });
      rmSync(f.repo.root, { recursive: true });
      expect(owned(f.path).workspace).toBe(locations(f.path).workspace);
      expect(readFileSync(join(locations(f.path).workspace, 'src/value.ts'), 'utf8')).toContain(
        '= 0',
      );
    } finally {
      f.dispose();
    }
  });
  it('prepares dependencies that remain usable without the original installation', async () => {
    const f = fixture();
    try {
      const dependencies = join(f.repo.root, 'node_modules');
      mkdirSync(join(dependencies, '.pnpm/example'), { recursive: true });
      writeFileSync(join(dependencies, '.pnpm/example/index.js'), 'module.exports = 1;');
      symlinkSync('.pnpm/example', join(dependencies, 'example'));
      await prepare(f.path, f.repo.root);
      rmSync(dependencies, { recursive: true });
      expect(
        readFileSync(join(locations(f.path).workspace, 'node_modules/example/index.js'), 'utf8'),
      ).toBe('module.exports = 1;');
      expect(f.repo.git('status', '--porcelain')).toBe('');
    } finally {
      f.dispose();
    }
  });
  it('keeps trusted collector writes outside candidate-controlled symlinks', async () => {
    const f = fixture();
    try {
      await prepare(f.path, f.repo.root);
      await beginAttempt(f.path, reservation);
      await applyPatch(f.path, f.proposal(change()));
      const dirs = locations(f.path),
        victim = join(f.store, 'host-evidence');
      mkdirSync(victim);
      writeFileSync(join(victim, 'verify.log'), 'Host data');
      const result = await evaluate(f.path, async (_command, args) => {
        if (args.at(-1) === '--version')
          return { exitCode: 0, signal: null, bounded: false, output: 'v24' };
        const generated = join(dirs.workspace, '.generated/harness');
        mkdirSync(generated, { recursive: true });
        symlinkSync(victim, join(generated, 'loop-attempt-1'));
        return { exitCode: 0, signal: null, bounded: false, output: 'Candidate output' };
      });
      expect(result.phase).toBe('review');
      expect(readFileSync(join(victim, 'verify.log'), 'utf8')).toBe('Host data');
      expect(
        readFileSync(join(dirs.root, '.generated/harness/loop-attempt-1/verify.log'), 'utf8'),
      ).toBe('Candidate output');
    } finally {
      f.dispose();
    }
  });
  it('does not count a clean checkout as repair progress after failed verification', async () => {
    const f = fixture();
    try {
      await prepare(f.path, f.repo.root);
      await beginAttempt(f.path, reservation);
      await applyPatch(f.path, f.proposal(change()));
      const result = await evaluate(f.path, async (_command, args) => ({
        exitCode: args.at(-1) === '--version' ? 0 : 1,
        signal: null,
        bounded: false,
        output: 'Verification failed',
      }));
      expect(result).toMatchObject({
        phase: 'ready',
        attempts: 1,
        noProgress: 1,
        verifiedSha: null,
      });
    } finally {
      f.dispose();
    }
  });
  it('blocks unavailable isolation without executing verification or refunding the attempt', async () => {
    const f = fixture();
    try {
      await prepare(f.path, f.repo.root);
      await beginAttempt(f.path, reservation);
      const candidate = await applyPatch(f.path, f.proposal(change()));
      let commands = 0;
      const result = await evaluate(f.path, async (command, args) => {
        commands++;
        expect(command).toBe('bwrap');
        expect(args.at(-1)).toBe('--version');
        return { exitCode: 1, signal: null, bounded: false, output: 'Namespace unavailable' };
      });
      expect(commands).toBe(1);
      expect(result).toMatchObject({
        phase: 'blocked',
        nextAction: 'recover',
        evaluationExitCode: 2,
        attempts: 1,
        externalCalls: 1,
        noProgress: 0,
        verifiedSha: null,
      });
      expect(readFileSync(result.evidence, 'utf8')).toContain('Namespace unavailable');
      await expect(beginAttempt(f.path, reservation)).rejects.toThrow();
      const resumed = await recover(f.path, 'Isolation repaired; previous process ended');
      expect(resumed).toMatchObject({
        phase: 'candidate',
        candidateSha: candidate.candidateSha,
        attempts: 1,
        externalCalls: 1,
        deadline: candidate.deadline,
      });
      expect(f.repo.git('status', '--porcelain')).toBe('');
    } finally {
      f.dispose();
    }
  });
});
it.each([
  'apps/web/dist',
  'apps/cli/dist',
  'apps/replay-reader/dist',
  'apps/cli/node_modules/.vite',
  'apps/cli/node_modules/.vite-temp',
])('never exposes tracked inputs in %s or dangling output symlinks as writable', (output) => {
  const f = fixture();
  try {
    symlinkSync(join(f.store, 'absent-host-target'), join(f.repo.root, '.generated'));
    expect(() => writableOutputs(f.repo.root)).toThrow(/Symlink/);
    rmSync(join(f.repo.root, '.generated'));
    mkdirSync(join(f.repo.root, output), { recursive: true });
    writeFileSync(join(f.repo.root, output, 'input.ts'), 'tracked input');
    f.repo.git('add', '-f', `${output}/input.ts`);
    expect(() => writableOutputs(f.repo.root)).toThrow(/tracked/);
    expect(readFileSync(join(f.repo.root, output, 'input.ts'), 'utf8')).toBe('tracked input');
  } finally {
    f.dispose();
  }
});
it('bounds evaluation, filters host secrets, and never falls back on missing isolation', async () => {
  const args = sandboxCommand(
    '/candidate',
    '/owned.git',
    ['vp', 'run', 'verify'],
    ['/candidate/.generated'],
  );
  expect(args).toContain('--unshare-all');
  expect(args).toContain('--clearenv');
  // A nested isolation test may already have the synthetic HOME. Host variables are
  // excluded by clearenv and the subprocess environment allowlist asserted below.
  const result = await isolatedCommand(
    '/candidate',
    '/owned.git',
    ['vp', 'run', 'verify'],
    25,
    [],
    async (command, _args, _cwd, options) => {
      expect(command).toBe('bwrap');
      expect(options?.timeoutMs).toBe(25);
      expect(Object.keys(options?.env ?? {})).toEqual(['PATH']);
      return {
        exitCode: 1,
        signal: null,
        bounded: false,
        output: 'Namespace creation unavailable',
      };
    },
  );
  expect(result.exitCode).toBe(1);
});
