import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Includes the installed verifier, metadata/scoring boundary, workflow and locked dependencies. */
export async function leagueValidatorDigest(root: string) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(
      (path) =>
        path &&
        (['.node-version', 'pnpm-lock.yaml'].includes(path) ||
          /^packages\/(domain|engine)\//.test(path) ||
          (/^(apps\/(api|cli)\/src\/|scripts\/league-|scripts\/(pages|league-artifact)-policy)/.test(
            path,
          ) &&
            path.endsWith('.ts') &&
            !path.endsWith('.test.ts')) ||
          /^\.github\/(actions\/league-|workflows\/league-)/.test(path)),
    )
    .sort();
  const hash = createHash('sha256');
  for (const path of files) {
    const data = await readFile(join(root, path));
    hash.update(path + '\0' + data.length + '\0').update(data);
  }
  return 'sha256:' + hash.digest('hex');
}
