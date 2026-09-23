import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runCommand } from '../process.ts';
import type { CommandResult } from '../process.ts';
import { assessReport } from '../report.ts';
import { collectSource, git } from '../source.ts';
import { readJournal, regularPath } from './journal.ts';
import { ensure, status, transition } from './state.ts';
import { operation, owned, scope } from './workspace.ts';

/** No host HOME, token, network or controller checkout is visible to candidate processes. */
export function sandboxCommand(
  workspace: string,
  repository: string,
  command: string[],
  writable: string[],
) {
  ensure(process.platform === 'linux', 'Evaluation requires Linux bubblewrap');
  const args = [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--clearenv',
  ];
  for (const directory of ['/usr', '/bin', '/lib', '/lib64', dirname(process.execPath)]) {
    if (existsSync(directory)) args.push('--ro-bind', directory, directory);
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/loop-home');
  args.push('--ro-bind', repository, repository, '--ro-bind', workspace, workspace);
  for (const path of writable) args.push('--bind', path, path);
  args.push(
    '--setenv',
    'HOME',
    '/tmp/loop-home',
    '--setenv',
    'TMPDIR',
    '/tmp',
    '--setenv',
    'CI',
    'true',
    '--setenv',
    'NO_COLOR',
    '1',
    '--setenv',
    'GIT_CONFIG_NOSYSTEM',
    '1',
    '--setenv',
    'GIT_CONFIG_GLOBAL',
    '/dev/null',
    '--setenv',
    'PATH',
    `${workspace}/node_modules/.bin:${dirname(process.execPath)}:/usr/bin:/bin`,
    '--chdir',
    workspace,
    ...command,
  );
  return args;
}
export async function isolatedCommand(
  workspace: string,
  repository: string,
  command: string[],
  timeoutMs: number,
  writable: string[] = [],
  run: typeof runCommand = runCommand,
): Promise<CommandResult> {
  return run('bwrap', sandboxCommand(workspace, repository, command, writable), workspace, {
    env: { PATH: '/usr/bin:/bin' },
    timeoutMs,
    maxBytes: 4 * 1024 * 1024,
  });
}
export async function evaluate(path: string) {
  return operation(path, async () => {
    const j = readJournal(path),
      view = status(j),
      dirs = owned(path, j);
    ensure(view.phase === 'candidate', 'A reserved applied candidate is required');
    scope(dirs.workspace, j.contract);
    const relative = `.generated/harness/loop-attempt-${view.attempts}`;
    // Only ignored build/cache outputs are writable. All tracked inputs and Git objects remain read-only.
    const outputs = [
      '.generated',
      'apps/web/dist',
      'apps/api/dist',
      'packages/domain/dist',
      'packages/engine/dist',
      'node_modules/.vite',
    ];
    const writable = outputs.map((p) => regularPath(join(dirs.workspace, p)));
    for (const output of writable) mkdirSync(output, { recursive: true });
    const before = git(dirs.workspace, ['status', '--porcelain=v1', '--untracked-files=all']);
    ensure(!before, 'Build output is not ignored');
    const runner: typeof runCommand = async (command, args, cwd) => {
      ensure(
        command === 'vp' && JSON.stringify(args) === '["run","verify"]' && cwd === dirs.workspace,
        'Unexpected evaluation command',
      );
      const remaining = Date.parse(view.deadline) - Date.now();
      ensure(remaining > 0, 'Deadline exceeded');
      return isolatedCommand(
        cwd,
        dirs.repository,
        [command, ...args],
        Math.min(720_000, remaining),
        writable,
      );
    };
    const result = await collectSource(dirs.workspace, relative, runner, {});
    owned(path, j);
    const evidence = join(dirs.root, 'evidence', `evaluation-${view.attempts}.json`);
    const assessed = assessReport(result.report, j.contract.requiredChecks);
    // Preserve trusted collector output separately from candidate-writable build outputs.
    writeFileSync(
      evidence,
      JSON.stringify(
        {
          report: assessed.report,
          command: JSON.parse(readFileSync(join(dirs.workspace, relative, 'command.json'), 'utf8')),
          log: readFileSync(join(dirs.workspace, relative, 'verify.log'), 'utf8'),
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    const interrupted = Date.now() >= Date.parse(view.deadline);
    if (interrupted) return { ...status(readJournal(path)), repairComplete: false, evidence };
    const next = transition(path, j, 'evaluated', {
      candidateSha: view.candidateSha,
      outcome: assessed.exitCode === 0 ? 'pass' : assessed.exitCode === 1 ? 'fail' : 'unknown',
      passed: assessed.report.checks.filter((c) => c.required && c.status === 'pass').length,
      evidence,
    });
    return { ...status(next), repairComplete: false, evidence };
  });
}
