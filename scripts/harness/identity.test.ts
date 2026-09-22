import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vite-plus/test';
import { sourceIdentity } from './source.ts';

it('binds the actual test-merge base despite an older PR event base', () => {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-identity-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    git('init');
    git('config', 'user.name', 'Harness fixture');
    git('config', 'user.email', 'harness@example.invalid');
    git('commit', '--allow-empty', '-m', 'original');
    const original = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    const candidate = git('commit-tree', tree, '-p', original, '-m', 'candidate');
    const base = git('commit-tree', tree, '-p', original, '-m', 'advanced base');
    const tested = git('commit-tree', tree, '-p', base, '-p', candidate, '-m', 'test merge');
    git('reset', '--hard', tested);
    const eventPath = join(root, '.git', 'event.json');
    const event = { pull_request: { head: { sha: candidate }, base: { sha: original } } };
    writeFileSync(eventPath, JSON.stringify(event));
    const env = {
      GITHUB_SHA: tested,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
    };
    assert.deepEqual(sourceIdentity(root, env), {
      sourceSha: tested,
      candidateSha: candidate,
      baselineSha: base,
      testMergeSha: tested,
    });
    event.pull_request.head.sha = original;
    writeFileSync(eventPath, JSON.stringify(event));
    assert.throws(() => sourceIdentity(root, env), /parents/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
