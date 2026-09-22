import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectSource, newArtifactDirectory, sourceIdentity } from './source.ts';

test('collector refuses dirty source, preserves real files and records incomplete verify', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-source-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init');
    git('config', 'user.name', 'Harness Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, '.gitignore'), '.generated/\n');
    writeFileSync(join(root, '.node-version'), process.version.slice(1));
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'fixture-only\n');
    git('add', '.');
    git('commit', '-m', 'test fixture');
    assert.equal(sourceIdentity(root).clean, true);
    writeFileSync(join(root, 'uncommitted.txt'), 'preserve this');
    const report = await collectSource(root, 'dirty-case');
    assert.equal(report.status, 'fail');
    assert.equal(report.checks.find((check) => check.id === 'verify')?.status, 'unknown');
    assert.equal(sourceIdentity(root).sourceSha, report.sourceSha);
    assert.throws(() => newArtifactDirectory(root, 'dirty-case'));
    assert.throws(() => newArtifactDirectory(root, '../escape'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
