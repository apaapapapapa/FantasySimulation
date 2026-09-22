import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assessReport, sha } from './report.ts';
import type { HarnessCheck, HarnessReport } from './report.ts';
import { runCommand } from './process.ts';

export const SOURCE_REQUIREMENTS = [
  { id: 'source-clean', scope: 'source' as const },
  { id: 'toolchain', scope: 'source' as const },
  { id: 'verify', scope: 'source' as const },
];
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
}
export function sourceIdentity(cwd: string) {
  return {
    sourceSha: sha(git(cwd, ['rev-parse', 'HEAD']).trim()),
    clean: git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length === 0,
  };
}
export function newArtifactDirectory(root: string, runId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(runId)) throw new Error('Invalid run ID');
  let directory = resolve(root);
  for (const component of ['.generated', 'harness', runId]) {
    directory = join(directory, component);
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (
        component === runId ||
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      ) throw error;
    }
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Unsafe artifact path');
  }
  return directory;
}
export async function collectSource(root: string, runId: string, baseline: string | null = null) {
  const startedAt = new Date().toISOString();
  const before = sourceIdentity(root);
  const candidateSha = sha(process.env.HARNESS_CANDIDATE_SHA ?? before.sourceSha);
  let baselineSha = baseline === null ? null : sha(baseline);
  if (candidateSha !== before.sourceSha) {
    const parents = git(root, ['show', '-s', '--format=%P', 'HEAD']).trim().split(' ');
    if (parents.length !== 2 || parents[1] !== candidateSha || (baselineSha && parents[0] !== baselineSha)) {
      throw new Error('Candidate is not the second parent of the tested merge');
    }
    baselineSha = sha(parents[0]);
  }
  if (baselineSha) git(root, ['cat-file', '-e', `${baselineSha}^{commit}`]);
  const expectedNode = readFileSync(join(root, '.node-version'), 'utf8').trim();
  const toolchainMatches = process.version === `v${expectedNode}`;
  const directory = newArtifactDirectory(root, runId);
  const command = process.platform === 'win32'
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'vp run verify'] }
    : { file: 'vp', args: ['run', 'verify'] };
  const result = before.clean && toolchainMatches
    ? await runCommand(command.file, command.args, root, 10 * 60 * 1000)
    : { exitCode: null, signal: null, reason: 'precondition failed', output: '' };
  const after = sourceIdentity(root);
  const clean = before.clean && after.clean && before.sourceSha === after.sourceSha;
  const uri = `.generated/harness/${runId}/receipt.json`;
  const receipt = {
    producer: 'fantasy/source-v1',
    sourceSha: before.sourceSha,
    candidateSha,
    afterSha: after.sourceSha,
    baselineSha,
    command: 'vp run verify',
    node: process.version,
    expectedNode,
    platform: process.platform,
    architecture: process.arch,
    cleanBefore: before.clean,
    cleanAfter: after.clean,
    lockSha256: createHash('sha256').update(readFileSync(join(root, 'pnpm-lock.yaml'))).digest('hex'),
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    signal: result.signal,
    reason: result.reason,
    logSha256: createHash('sha256').update(result.output).digest('hex'),
  };
  writeFileSync(join(directory, 'verify.log'), result.output, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const check = (id: string, status: HarnessCheck['status'], reason: string): HarnessCheck => ({
    id, scope: 'source', required: true, status, reason,
    evidence: [{ uri, sourceSha: before.sourceSha }],
  });
  const report: HarnessReport = {
    schemaVersion: 1,
    producer: receipt.producer,
    runId,
    sourceSha: before.sourceSha,
    candidateSha,
    baselineSha,
    startedAt,
    finishedAt: receipt.finishedAt,
    checks: [
      check('source-clean', clean ? 'pass' : 'fail', clean ? 'unchanged clean commit' : 'dirty or changed source'),
      check('toolchain', toolchainMatches ? 'pass' : 'fail', `Node ${process.version}; required ${expectedNode}`),
      check('verify', result.reason === 'precondition failed' ? 'unknown' : result.exitCode === 0 && result.reason === 'completed' ? 'pass' : 'fail', `vp run verify: ${result.reason}; exit=${result.exitCode}`),
    ],
  };
  const assessed = assessReport(report, SOURCE_REQUIREMENTS);
  writeFileSync(join(directory, 'report.json'), `${JSON.stringify(assessed, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return assessed;
}
