import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, repositoryRoot } from '../source.ts';
import { readBoundedBytes, readBoundedJson } from '../files.ts';
import { record, sha, text } from '../report.ts';
import { digest, isTestPath, pathAllowed, relativePath, taskId } from './contract.ts';
import type { Contract } from './contract.ts';
import { atomicWrite, readJournal, regularPath } from './journal.ts';
import { begin, ensure, status, transition } from './state.ts';

export const controllerRoot = repositoryRoot(fileURLToPath(new URL('../../../', import.meta.url)));
export const locations = (path: string) => {
  const root = dirname(regularPath(path));
  return {
    root,
    workspace: join(root, 'worktree'),
    repository: join(root, 'repository.git'),
    owner: join(root, 'owner.json'),
  };
};
export async function operation<T>(path: string, work: () => T | Promise<T>): Promise<T> {
  const lock = regularPath(path) + '.operation.lock',
    fd = openSync(lock, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return await work();
  } finally {
    closeSync(fd);
    rmSync(lock);
  }
}
const clean = (root: string) =>
  ensure(!git(root, ['status', '--porcelain=v1', '--untracked-files=all']), 'Dirty checkout');
function remoteRepository(root: string) {
  const remote = git(root, ['remote', 'get-url', 'origin']);
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
    remote,
  );
  ensure(match, 'Unexpected repository remote');
  return match[1];
}
export function owned(path: string, journal = readJournal(path), requireClean = true) {
  const dirs = locations(path),
    owner = record(readBoundedJson(dirs.owner));
  ensure(
    owner.contractHash === journal.contractHash &&
      owner.controllerRoot === controllerRoot &&
      owner.workspace === dirs.workspace &&
      owner.repository === dirs.repository,
    'Workspace owner mismatch',
  );
  ensure(regularPath(dirs.workspace) === realpathSync(dirs.workspace), 'Workspace path mismatch');
  ensure(
    relative(dirs.workspace, controllerRoot).startsWith('..'),
    'Controller must be outside candidate',
  );
  ensure(
    git(dirs.workspace, ['branch', '--show-current']) === `loop/${taskId(journal.contract)}`,
    'Wrong branch',
  );
  ensure(remoteRepository(dirs.workspace) === journal.contract.repository, 'Wrong repository');
  ensure(
    realpathSync(git(dirs.workspace, ['rev-parse', '--git-common-dir'])) ===
      realpathSync(dirs.repository),
    'Wrong Git ownership',
  );
  ensure(
    git(dirs.workspace, ['rev-parse', 'HEAD']) === status(journal).candidateSha,
    'Stale candidate SHA',
  );
  if (requireClean) clean(dirs.workspace);
  return dirs;
}
export function copyDependencies(root: string, workspace: string) {
  for (const prefix of ['', 'apps/api', 'apps/web', 'packages/domain', 'packages/engine']) {
    const dependencies = join(root, prefix, 'node_modules');
    if (existsSync(dependencies))
      cpSync(dependencies, join(workspace, prefix, 'node_modules'), {
        recursive: true,
        verbatimSymlinks: true,
      });
  }
}
export async function prepare(path: string, source: string) {
  return operation(path, () => {
    const j = readJournal(path),
      view = status(j),
      dirs = locations(path),
      root = repositoryRoot(source);
    if (view.phase !== 'initialized') {
      owned(path, j);
      return view;
    }
    ensure(process.platform === 'linux', 'Only Linux is supported');
    clean(root);
    ensure(remoteRepository(root) === j.contract.repository, 'Source repository mismatch');
    ensure(
      git(root, ['rev-parse', 'HEAD']) === j.contract.baselineSha,
      'Source is not the frozen baseline',
    );
    ensure(
      !existsSync(dirs.repository) && !existsSync(dirs.workspace),
      'Interrupted prepare: preserve and reconcile existing workspace',
    );
    git(dirs.root, ['clone', '--bare', '--no-local', root, dirs.repository]);
    git(dirs.root, [
      '--git-dir',
      dirs.repository,
      'remote',
      'set-url',
      'origin',
      `https://github.com/${j.contract.repository}.git`,
    ]);
    git(dirs.root, [
      '--git-dir',
      dirs.repository,
      'update-ref',
      'refs/remotes/origin/main',
      j.contract.baselineSha,
    ]);
    git(dirs.root, [
      '--git-dir',
      dirs.repository,
      'worktree',
      'add',
      '-b',
      `loop/${taskId(j.contract)}`,
      dirs.workspace,
      j.contract.baselineSha,
    ]);
    copyDependencies(root, dirs.workspace);
    atomicWrite(dirs.owner, {
      contractHash: j.contractHash,
      controllerRoot,
      workspace: dirs.workspace,
      repository: dirs.repository,
    });
    const updated = transition(path, j, 'prepared', { workspace: dirs.workspace });
    owned(path, updated);
    return status(updated);
  });
}
export async function beginAttempt(path: string, reservation: unknown) {
  return operation(path, () => {
    owned(path);
    return status(begin(path, reservation));
  });
}
export function scope(root: string, contract: Contract, staged = false) {
  const raw = git(root, [
    'diff',
    '--raw',
    '--abbrev=40',
    '--no-renames',
    '-z',
    ...(staged ? ['--cached'] : []),
    contract.baselineSha,
    ...(staged ? [] : ['HEAD']),
    '--',
  ]);
  const fields = raw ? raw.split('\0') : [];
  if (fields.length) ensure(fields.pop() === '', 'Truncated change list');
  ensure(fields.length % 2 === 0 && fields.length <= 400, 'Change list exceeds bound');
  const changes: { path: string; status: string }[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} ([AMD])$/.exec(fields[i]!);
    ensure(match, 'Unsupported change type');
    const [, before, after, kind] = match,
      path = relativePath(fields[i + 1]);
    ensure(
      [before, after].every((mode) => mode === '000000' || mode === '100644') ||
        (before === '100755' && after === '100755'),
      'Symlink, gitlink or mode change',
    );
    ensure(before === '000000' || after === '000000' || before === after, 'Mode change');
    ensure(
      pathAllowed(contract, path) && (!isTestPath(path) || kind === 'A'),
      `Protected or outside allowed scope: ${path}`,
    );
    changes.push({ path, status: kind! });
  }
  ensure(changes.length, 'Empty candidate');
  return changes;
}
export async function applyPatch(path: string, proposal: unknown) {
  return operation(path, () => {
    const j = readJournal(path),
      view = status(j),
      dirs = owned(path, j),
      p = record(proposal);
    const patch = readBoundedBytes(regularPath(text(p.patch)), 1024 * 1024),
      patchHash = digest(patch.toString('utf8'));
    ensure(p.attempt === view.attempts, 'Patch attempt mismatch');
    if (view.phase === 'candidate' && patchHash === view.patchHash) return view;
    ensure(view.phase === 'running' && sha(p.baseSha) === view.candidateSha, 'Stale patch base');
    mkdirSync(join(dirs.root, 'evidence'), { recursive: true });
    const retained = join(dirs.root, 'evidence', `patch-${view.attempts}.diff`);
    writeFileSync(retained, patch, { flag: 'wx', mode: 0o600 });
    let next = transition(path, j, 'applying', { baseSha: view.candidateSha, patchHash });
    try {
      git(dirs.workspace, [
        '-c',
        'core.hooksPath=/dev/null',
        'apply',
        '--cached',
        '--whitespace=error',
        retained,
      ]);
      const changes = scope(dirs.workspace, j.contract, true);
      // Commit the validated index before materializing it. No candidate hook is executed.
      git(dirs.workspace, [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Fantasy repair',
        '-c',
        'user.email=repair@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        `fix: manual repair attempt ${view.attempts}`,
      ]);
      git(dirs.workspace, ['reset', '--hard', 'HEAD']);
      const candidateSha = sha(git(dirs.workspace, ['rev-parse', 'HEAD']));
      next = transition(path, next, 'applied', {
        patchHash,
        candidateSha,
        changes,
        evidence: retained,
      });
      owned(path, next);
      return status(next);
    } catch (error) {
      // Only this owned disposable checkout is restored. The reservation remains spent.
      git(dirs.workspace, ['reset', '--hard', view.candidateSha]);
      transition(path, next, 'interrupted', {
        reason: error instanceof Error ? error.message : 'Patch failed',
      });
      throw error;
    }
  });
}
export async function recover(path: string, reason: string) {
  return operation(path, () => {
    const j = readJournal(path),
      dirs = locations(path),
      view = status(j);
    if (view.phase === 'blocked') {
      owned(path, j);
      return status(transition(path, j, 'resumed', { reason: text(reason) }));
    }
    ensure(['running', 'applying', 'candidate'].includes(view.phase), 'No interrupted attempt');
    // Validate identity before touching an owned checkout, permitting only this attempt's dirty index.
    const head = git(dirs.workspace, ['rev-parse', 'HEAD']);
    ensure(
      head === view.candidateSha,
      'Interrupted commit needs explicit normal engineering reconciliation',
    );
    owned(path, j, false);
    git(dirs.workspace, ['reset', '--hard', view.candidateSha]);
    clean(dirs.workspace);
    return status(transition(path, j, 'interrupted', { reason: text(reason) }));
  });
}
