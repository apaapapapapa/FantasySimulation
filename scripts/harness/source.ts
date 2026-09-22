import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { assessReport, identity, record, sha } from './report.ts';
import type { Report } from './report.ts';
import { runCommand, safeEnvironment } from './process.ts';

export const SOURCE_CHECKS = ['source-clean', 'source-verify'] as const;
export function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}
export function artifactDirectory(root: string, relative: string): string {
  if (
    !/^\.generated\/harness\/[\w.-]+(?:\/[\w.-]+)*$/.test(relative) ||
    relative.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('Use a fresh .generated/harness/<run> directory');
  let directory = realpathSync(root);
  for (const part of relative.split('/')) {
    directory = join(directory, part);
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
      throw new Error('Evidence directories cannot contain symlinks');
  }
  if (existsSync(directory)) throw new Error('Evidence directory already exists');
  mkdirSync(directory, { recursive: true });
  return directory;
}
export function sourceIdentity(root: string, env: NodeJS.ProcessEnv = process.env) {
  const sourceSha = sha(git(root, ['rev-parse', 'HEAD']));
  if (env.GITHUB_SHA && env.GITHUB_SHA !== sourceSha)
    throw new Error('Checkout differs from CI source');
  let candidateSha = sourceSha;
  let baselineSha: string | null = null;
  let testMergeSha: string | null = null;
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    if (!env.GITHUB_EVENT_PATH) throw new Error('PR event identity missing');
    const event = record(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as unknown);
    const pull = record(event.pull_request);
    candidateSha = sha(record(pull.head).sha);
    sha(record(pull.base).sha); // Validate the event, but it may describe an older base.
    const parents = git(root, ['show', '-s', '--format=%P', 'HEAD']).split(' ');
    if (parents.length !== 2 || parents[1] !== candidateSha)
      throw new Error('PR test-merge parents do not match the event');
    baselineSha = sha(parents[0]);
    testMergeSha = sourceSha;
  }
  return identity({ sourceSha, candidateSha, baselineSha, testMergeSha });
}
export async function collectSource(
  root: string,
  relative: string,
  run: typeof runCommand = runCommand,
  env: NodeJS.ProcessEnv = process.env,
) {
  root = realpathSync.native(root);
  // Git may return an 8.3 TEMP path on Windows; compare canonical filesystem paths.
  if (realpathSync.native(git(root, ['rev-parse', '--show-toplevel'])) !== root)
    throw new Error('Run from the repository root');
  const info = sourceIdentity(root, env);
  const { sourceSha } = info;
  const startedAt = new Date().toISOString();
  const before = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const directory = artifactDirectory(root, relative);
  const result = before
    ? null
    : await run('vp', ['run', 'verify'], root, {
        env: { ...safeEnvironment(process.env), CI: 'true', NO_COLOR: '1' },
      });
  const after = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const unchanged = !before && !after && git(root, ['rev-parse', 'HEAD']) === sourceSha;
  if (result && (result.exitCode !== 0 || result.bounded)) process.stderr.write(result.output);
  writeFileSync(
    join(directory, 'verify.log'),
    result?.output ?? 'Not run: checkout was not clean.\n',
  );
  writeFileSync(
    join(directory, 'command.json'),
    JSON.stringify(
      {
        ...info,
        command: ['vp', 'run', 'verify'],
        platform: process.platform,
        nodeVersion: process.version,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: result?.exitCode ?? null,
        signal: result?.signal ?? null,
        bounded: result?.bounded ?? false,
        cleanBefore: !before,
        cleanAfter: !after,
      },
      null,
      2,
    ) + '\n',
  );
  const report: Report = {
    ...info,
    schemaVersion: 1,
    producer: 'source-runner',
    startedAt,
    finishedAt: new Date().toISOString(),
    checks: [
      {
        id: 'source-clean',
        required: true,
        status: unchanged ? 'pass' : 'fail',
        reason: unchanged
          ? 'Clean, unchanged source tree'
          : 'Dirty checkout or source changed during verification',
        evidence: [{ uri: `${relative}/command.json`, sourceSha }],
      },
      {
        id: 'source-verify',
        required: true,
        status:
          result === null ? 'unknown' : result.exitCode === 0 && !result.bounded ? 'pass' : 'fail',
        reason:
          result === null
            ? 'Verification not run'
            : `vp run verify exit=${result.exitCode}; bounded=${result.bounded}`,
        evidence: [
          { uri: `${relative}/verify.log`, sourceSha },
          { uri: `${relative}/command.json`, sourceSha },
        ],
      },
    ],
  };
  const assessed = assessReport(report, SOURCE_CHECKS);
  writeFileSync(join(directory, 'report.json'), JSON.stringify(assessed.report, null, 2) + '\n');
  return assessed;
}
