import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Disposable committed Git checkout for harness tests; callers must dispose it. */
export function testRepository(files: Record<string, string> = { 'source.txt': 'original\n' }) {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-harness-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const dispose = () => rmSync(root, { recursive: true, force: true });
  try {
    git('init');
    git('config', 'user.name', 'Harness fixture');
    git('config', 'user.email', 'harness@example.invalid');
    git('config', 'core.autocrlf', 'false');
    for (const [path, content] of Object.entries({ '.gitignore': '.generated/\n', ...files })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    git('add', '.');
    git('commit', '-m', 'fixture');
    return { root, git, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
