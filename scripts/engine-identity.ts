import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('packages/engine/src/spatial/implementation.json', root);
async function sourceFiles(path: string): Promise<string[]> {
  const entries = await readdir(new URL(`${path}/`, root), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(...(await sourceFiles(`${path}/${entry.name}`)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      files.push(`${path}/${entry.name}`);
  }
  return files;
}
const files = [
  ...(await sourceFiles('packages/domain/src/spatial')),
  ...(await sourceFiles('packages/engine/src/spatial')),
  'packages/domain/package.json',
  'packages/engine/package.json',
  'package.json',
  'pnpm-lock.yaml',
  '.node-version',
  'tsconfig.json',
  'scripts/engine-identity.ts',
  'packages/engine/src/spatial/sine-table.json',
  'packages/engine/src/spatial/profile.json',
].sort();
// Source identity v1: UTF-8 JSON of sorted [POSIX path, LF-normalized content] pairs.
// Include lockfile/toolchain inputs; exclude fixtures, tests and this generated output.
const sources = await Promise.all(
  files.map(async (path) => [
    path,
    (await readFile(new URL(path, root), 'utf8')).replaceAll('\r\n', '\n'),
  ]),
);
const rapier = new URL('packages/engine/node_modules/@dimforge/rapier3d-compat/', root);
const sha = (bytes: Uint8Array | string) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const wasm = sha(await readFile(new URL('dist/rapier_wasm3d_bg.wasm', rapier)));
const binding = sha(await readFile(new URL('dist/rapier.mjs', rapier)));
const table = sha(
  await readFile(new URL('packages/engine/src/spatial/sine-table.json', root), 'utf8').then(
    (text) => text.replaceAll('\r\n', '\n'),
  ),
);
sources.push(['rapier-wasm', wasm], ['rapier-binding', binding], ['angle-table', table]);
const digest = `sha256:${createHash('sha256').update(JSON.stringify(sources)).digest('hex')}`;
const expected = `${JSON.stringify({ digest, wasm, binding, table }, null, 2)}\n`;
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
