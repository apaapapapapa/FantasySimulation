import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('packages/engine/src/tick-v1/implementation.json', root);
async function sourceFiles(path: string): Promise<string[]> {
  const entries = await readdir(new URL(`${path}/`, root), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(...(await sourceFiles(`${path}/${entry.name}`)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      files.push(`${path}/${entry.name}`);
  }
  return files;
}
const files = [
  ...(await sourceFiles('packages/domain/src/tick-v1')),
  ...(await sourceFiles('packages/engine/src/tick-v1')),
  'packages/domain/package.json',
  'packages/engine/package.json',
  'package.json',
  'pnpm-lock.yaml',
  '.node-version',
  'tsconfig.json',
  'scripts/engine-identity.ts',
].sort();
// Source identity v1: UTF-8 JSON of sorted [POSIX path, LF-normalized content] pairs.
// Include lockfile/toolchain inputs; exclude fixtures, tests and this generated output.
const sources = await Promise.all(
  files.map(async (path) => [
    path,
    (await readFile(new URL(path, root), 'utf8')).replaceAll('\r\n', '\n'),
  ]),
);
const digest = `sha256:${createHash('sha256').update(JSON.stringify(sources)).digest('hex')}`;
const expected = `${JSON.stringify({ digest }, null, 2)}\n`;
if (process.argv.includes('--write')) {
  await writeFile(output, expected);
  console.log(`Stamped ${files.length} source inputs: ${digest}`);
} else {
  const actual = (await readFile(output, 'utf8')).replaceAll('\r\n', '\n');
  if (actual !== expected)
    throw new Error(
      `Stale engine identity: ${fileURLToPath(output)}. Review rules/version changes, then run vp run engine:stamp and explicitly regenerate fixtures.`,
    );
  console.log(`Engine identity verified: ${digest}`);
}
