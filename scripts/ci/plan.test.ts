import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { classify, collectPlan, parsePlan, wordingOnly } from './plan.ts';
import { assessGate } from './gate.ts';
import type { Identity, Report } from '../harness/report.ts';
const info: Identity = {
  sourceSha: 'a'.repeat(40),
  candidateSha: 'b'.repeat(40),
  baselineSha: 'c'.repeat(40),
  testMergeSha: 'a'.repeat(40),
};
function evidence(ids: string[]): Report {
  return {
    ...info,
    schemaVersion: 1,
    producer: 'fixture',
    startedAt: '2026-09-22T00:00:00Z',
    finishedAt: '2026-09-22T00:00:01Z',
    checks: ids.map((id) => ({
      id,
      required: true,
      status: 'pass',
      reason: 'Executed assertion',
      evidence: [{ uri: '.generated/result.json', sourceSha: info.sourceSha }],
    })),
  };
}
describe('conservative CI planning', () => {
  it('shortcuts only nonempty wording-only PRs', () => {
    expect(classify(info, 'pull_request', ['README.md', 'docs/usage.md']).full).toBe(false);
    for (const path of [
      'AGENTS.md',
      '.agents/skills/a.md',
      '.github/harness/README.md',
      'docs/rules/a.md',
      'docs/adr/001.md',
      'docs/development/ci.md',
      'db/migrations/001.sql',
      'packages/domain/data.json',
      'data/a.json',
      'pnpm-lock.yaml',
      'vite.config.ts',
      'scripts/ci/plan.ts',
      'apps/web/a.ts',
      'docs/config.ts',
      'README.md\napp.ts',
    ])
      expect(wordingOnly([path])).toBe(false);
  });
  it('unknown, empty, deletion/rename of source, main and manual are full', () => {
    for (const paths of [null, [], ['packages/domain/deleted.ts', 'docs/moved.md']])
      expect(classify(info, 'pull_request', paths).full).toBe(true);
    for (const event of ['push', 'workflow_dispatch', 'unknown'])
      expect(classify(info, event, ['README.md']).full).toBe(true);
    expect(
      classify({ ...info, baselineSha: null, testMergeSha: null }, 'pull_request', ['README.md'])
        .full,
    ).toBe(true);
    expect(() => parsePlan({ ...classify(info, 'push', ['README.md']), full: false })).toThrow(
      Error,
    );
  });
});
describe('fail-closed CI gate', () => {
  const plan = classify(info, 'pull_request', ['apps/web/a.ts']);
  const results = {
    changes: 'success',
    security: 'success',
    'dependency-policy': 'success',
    verify: 'success',
    docs: 'skipped',
  };
  const reports = {
    'ubuntu-latest': evidence(['source-clean', 'source-verify']),
    'windows-latest': evidence(['source-clean', 'source-verify']),
  };
  it('requires both operating systems and exact source identities', () => {
    expect(assessGate(plan, results, reports).exitCode).toBe(0);
    expect(assessGate(plan, results, { 'ubuntu-latest': reports['ubuntu-latest'] }).exitCode).toBe(
      2,
    );
    expect(
      assessGate(plan, results, {
        ...reports,
        'windows-latest': { ...reports['windows-latest'], candidateSha: 'd'.repeat(40) },
      }).exitCode,
    ).toBe(2);
  });
  it('rejects job failure, cancellation, unplanned skip and absence', () => {
    for (const value of ['failure', 'cancelled', 'skipped', undefined])
      expect(assessGate(plan, { ...results, verify: value }, reports).exitCode).toBe(1);
    expect(assessGate(plan, { ...results, changes: 'failure' }, reports).exitCode).toBe(1);
    expect(assessGate(plan, { ...results, security: 'skipped' }, reports).exitCode).toBe(1);
  });
  it('permits planned skip only with passing lightweight evidence', () => {
    const docs = classify(info, 'pull_request', ['README.md']),
      observed = {
        changes: 'success',
        security: 'success',
        'dependency-policy': 'success',
        verify: 'skipped',
        docs: 'success',
      };
    expect(
      assessGate(docs, observed, {
        'docs-ubuntu-latest': evidence(['docs:diff', 'docs:links']),
        'docs-windows-latest': evidence(['docs:diff', 'docs:links']),
      }).exitCode,
    ).toBe(0);
    expect(assessGate(docs, observed, {}).exitCode).toBe(2);
    expect(
      assessGate(docs, observed, { 'docs-ubuntu-latest': evidence(['docs:diff', 'docs:links']) })
        .exitCode,
    ).toBe(2);
    expect(assessGate(docs, { ...observed, docs: 'skipped' }, {}).exitCode).toBe(1);
  });
});
it(
  'collects exact test-merge parents and preserves a renamed source deletion',
  { timeout: 15000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'fantasy-ci-plan-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
    try {
      git('init');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      mkdirSync(join(root, 'apps'));
      mkdirSync(join(root, 'docs'));
      writeFileSync(join(root, 'apps', 'source.ts'), 'export {};\n');
      git('add', '.');
      git('commit', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      git('mv', 'apps/source.ts', 'docs/renamed.md');
      git('commit', '-m', 'rename');
      const candidate = git('rev-parse', 'HEAD');
      const tested = git(
        'commit-tree',
        git('rev-parse', 'HEAD^{tree}'),
        '-p',
        base,
        '-p',
        candidate,
        '-m',
        'test merge',
      );
      git('reset', '--hard', tested);
      const eventPath = join(root, '.git', 'event.json');
      writeFileSync(
        eventPath,
        JSON.stringify({
          pull_request: { head: { sha: candidate }, base: { sha: 'd'.repeat(40) } },
        }),
      );
      const env = {
          GITHUB_SHA: tested,
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_EVENT_PATH: eventPath,
        },
        plan = collectPlan(root, env);
      expect(plan.baselineSha).toBe(base);
      expect(plan.candidateSha).toBe(candidate);
      expect(plan.paths).toEqual(['apps/source.ts', 'docs/renamed.md']);
      expect(plan.full).toBe(true);
      expect(collectPlan(root, { ...env, GITHUB_EVENT_PATH: join(root, 'missing') }).full).toBe(
        true,
      );
      expect(() => collectPlan(root, { ...env, GITHUB_SHA: 'e'.repeat(40) })).toThrow(Error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
