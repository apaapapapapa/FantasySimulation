// Read-only formatting diagnostics: stdout suggestions, never changes to the checked-out source.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { artifactDirectory, git } from './source.ts';
import { safeEnvironment } from './process.ts';

const root = process.cwd();
const output = artifactDirectory(root, '.generated/harness/format-suggestions');
const sourceSha = git(root, ['rev-parse', 'HEAD']);
const files = git(root, ['ls-files', '-z', '--', 'scripts/*.ts', 'scripts/**/*.ts', 'vite.config.ts', 'package.json']).split('\0').filter(Boolean);
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  if (Buffer.byteLength(source) > 1024 * 1024) throw new Error('Source exceeds formatting budget');
  const formatted = execFileSync('vp', ['fmt', '--stdin-filepath', file], {
    cwd: root, input: source, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    env: safeEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (source === formatted) continue;
  const destination = join(output, file);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, formatted);
}
writeFileSync(join(output, 'identity.json'), JSON.stringify({ sourceSha, kind: 'format-suggestions-only' }, null, 2) + '\n');
