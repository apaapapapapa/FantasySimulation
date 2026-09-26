import { readBoundedJson } from '../harness/files.ts';
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, record, sha } from '../harness/report.ts';
import type { Identity } from '../harness/report.ts';
export interface Plan extends Identity {
  schemaVersion: 1;
  event: string;
  full: boolean;
  simulation: boolean;
  codeql: boolean;
  ui: boolean;
  load: boolean;
  reason: string;
  paths: string[];
}
// Only wording documents are eligible; unknown files and executable/configuration docs run full CI.
export function wordingOnly(paths: readonly string[]): boolean {
  return (
    paths.length > 0 &&
    paths.every((path) => {
      if (/^(?:AGENTS|CLAUDE)\.md$/i.test(path)) return false;
      if (/^(?:\.agents|\.github|scripts|packages|apps|data|db)\//.test(path)) return false;
      if (/^docs\/(?:rules|adr|development|tooling|security|architecture)(?:[/.]|$)/.test(path))
        return false;
      return (
        path === 'README.md' || /^docs\/[\w./-]+\.md$/.test(path) || path === 'analysis/README.md'
      );
    })
  );
}
export function classify(info: Identity, event: string, paths: string[] | null): Plan {
  const full =
    event !== 'pull_request' || info.baselineSha === null || paths === null || !wordingOnly(paths);
  // Only known presentation files may exclude engine checks. Manifests, shared code,
  // configuration, deleted/renamed source outside this allowlist and uncertainty run everything.
  const presentationOnly =
    paths !== null &&
    paths.length > 0 &&
    paths.every(
      (path) =>
        wordingOnly([path]) ||
        /^apps\/web\/(?:src\/[\w./-]+\.(?:tsx?|css)|index\.html)$/.test(path),
    );
  const simulation = event !== 'pull_request' || info.baselineSha === null || !presentationOnly;
  // PRs use the fast lane; browser E2E, CodeQL and paired load gate main, dispatch and schedule
  // runs, and the release that follows them, instead of every PR.
  const extended = event !== 'pull_request';
  return {
    ...info,
    schemaVersion: 1,
    event,
    full,
    simulation,
    codeql: extended,
    ui: extended,
    load: extended,
    reason: !full
      ? 'Known nonempty PR diff contains only wording documents'
      : extended
        ? 'All checks: main/dispatch/schedule, including browser E2E, CodeQL and paired load'
        : simulation
          ? 'PR fast lane: static checks, all tests, build, corpus and security; E2E, CodeQL and paired load run on main'
          : 'Presentation-only PR fast lane: static checks, all tests, build and security; corpus excluded',
    paths: paths ?? [],
  };
}
export function parsePlan(input: unknown): Plan {
  const value = record(input),
    info = identity(value);
  if (
    value.schemaVersion !== 1 ||
    typeof value.event !== 'string' ||
    typeof value.full !== 'boolean' ||
    !Array.isArray(value.paths) ||
    value.paths.length > 10000 ||
    value.paths.some((path) => typeof path !== 'string' || !path || path.includes('\0')) ||
    typeof value.reason !== 'string'
  )
    throw new Error('Invalid CI plan');
  const paths = value.paths as string[];
  if (
    !value.full &&
    (value.event !== 'pull_request' ||
      info.testMergeSha === null ||
      info.baselineSha === null ||
      !wordingOnly(paths))
  )
    throw new Error('Unjustified CI short circuit');
  const expected = classify(info, value.event, paths);
  if (
    value.full !== expected.full ||
    value.simulation !== expected.simulation ||
    value.codeql !== expected.codeql ||
    value.ui !== expected.ui ||
    value.load !== expected.load
  )
    throw new Error('CI scope differs from the conservative path policy');
  return {
    ...info,
    schemaVersion: 1,
    event: value.event,
    full: value.full,
    simulation: expected.simulation,
    codeql: expected.codeql,
    ui: expected.ui,
    load: expected.load,
    paths,
    reason: value.reason,
  };
}
function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export function collectPlan(root: string, env: NodeJS.ProcessEnv): Plan {
  const sourceSha = sha(git(root, ['rev-parse', 'HEAD']).trim());
  if (env.GITHUB_SHA && env.GITHUB_SHA !== sourceSha)
    throw new Error('CI checkout identity mismatch');
  const event = env.GITHUB_EVENT_NAME ?? 'local';
  let candidateSha = sourceSha,
    baselineSha: string | null = null,
    testMergeSha: string | null = null;
  try {
    const eventPath = env.GITHUB_EVENT_PATH;
    if (!eventPath) throw new Error('Missing/bounded event');
    const payload = record(readBoundedJson(eventPath, 2 * 1024 * 1024));
    if (event === 'pull_request') {
      candidateSha = sha(record(record(payload.pull_request).head).sha);
      const parents = git(root, ['show', '-s', '--format=%P', 'HEAD']).trim().split(' ');
      if (parents.length !== 2 || parents[1] !== candidateSha)
        throw new Error('Unconfirmed test merge parents');
      baselineSha = sha(parents[0]);
      testMergeSha = sourceSha;
    } else if (event === 'push') baselineSha = sha(payload.before);
    else if (event === 'workflow_dispatch') baselineSha = sha(record(payload.inputs).baseline);
    else if (event === 'schedule') baselineSha = sha(git(root, ['rev-parse', 'HEAD^']).trim());
    if (!baselineSha) throw new Error('No comparison baseline');
    git(root, ['cat-file', '-e', `${baselineSha}^{commit}`]);
    const diff = git(root, [
      'diff',
      '--no-renames',
      '--name-only',
      '-z',
      baselineSha,
      sourceSha,
      '--',
    ]);
    if (diff && !diff.endsWith('\0')) throw new Error('Incomplete diff');
    const paths = diff ? diff.slice(0, -1).split('\0') : [];
    if (paths.length > 10000) throw new Error('Diff exceeds budget');
    return classify({ sourceSha, candidateSha, baselineSha, testMergeSha }, event, paths);
  } catch {
    return classify({ sourceSha, candidateSha, baselineSha, testMergeSha }, event, null);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = process.argv[2];
    if (!output) throw new Error('Usage: plan.ts <output.json>');
    const plan = collectPlan(process.cwd(), process.env);
    writeFileSync(output, JSON.stringify(plan, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `full=${plan.full}\nsimulation=${plan.simulation}\ncodeql=${plan.codeql}\nui=${plan.ui}\nload=${plan.load}\nbaseline=${plan.baselineSha ?? ''}\n`,
      );
    console.log(`FANTASY_CI_PLAN=${JSON.stringify(plan)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'CI planning failed');
    process.exitCode = 1;
  }
}
