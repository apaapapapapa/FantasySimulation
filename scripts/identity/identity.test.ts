import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vite-plus/test';
import { engineIdentity, verifyIdentity } from './identity.ts';
import { ENTRY, OUTPUT } from './closure.ts';
import { DOMAIN, ENGINE, SPATIAL, RAPIER, identityProject } from './test-support/project.ts';

const projects: ReturnType<typeof identityProject>[] = [];
function fixture() {
  const project = identityProject();
  projects.push(project);
  return project;
}
afterEach(() => {
  for (const project of projects.splice(0)) project.dispose();
});

it('follows nested runtime exports, side effects, JSON, literal dynamic imports and cycles exactly once', () => {
  const f = fixture(),
    identity = engineIdentity(f.root);
  expect(identity.payload.sources.map(([path]) => path)).toEqual([
    '.node-version',
    `${DOMAIN}/src/spatial/execution.ts`,
    `${SPATIAL}/boot.ts`,
    ENTRY,
    `${SPATIAL}/lazy.ts`,
    `${SPATIAL}/nested.ts`,
    `${SPATIAL}/profile.json`,
    `${SPATIAL}/sine-table.json`,
  ]);
  expect(identity.payload.dependencies.packages.map((pkg) => pkg.id)).toEqual([
    '@dimforge/rapier3d-compat@0.20.0',
    'zod@4.6.5',
  ]);
});
it.each([
  [`${SPATIAL}/boot.ts`, 'const boot = 2;\n'],
  [`${SPATIAL}/profile.json`, '{"step":30}\n'],
  [`${SPATIAL}/sine-table.json`, '[0,2,0,-2]\n'],
  [`${RAPIER}/dist/rapier_wasm3d_bg.wasm`, 'different wasm'],
  [`${RAPIER}/dist/rapier.mjs`, 'export const binding = 2;\n'],
])('changes identity when execution input %s changes', (path, content) => {
  const f = fixture(),
    before = engineIdentity(f.root).implementation.digest;
  f.write(path, content);
  expect(engineIdentity(f.root).implementation.digest).not.toBe(before);
});
it('ignores unrelated contracts, samples, application code, scripts, dev dependencies and type-only files', () => {
  const f = fixture(),
    before = engineIdentity(f.root).implementation;
  for (const path of [
    'apps/web/src/view.ts',
    'apps/api/src/http.ts',
    'packages/samples/src/catalog.ts',
    `${DOMAIN}/src/spatial/publication.ts`,
    `${DOMAIN}/src/spatial/api.ts`,
    `${SPATIAL}/types.ts`,
    `${SPATIAL}/manifest-builder.ts`,
  ])
    f.write(path, 'export type Hidden = number; export const unrelated = 2;\n');
  f.write(
    'package.json',
    JSON.stringify({
      type: 'module',
      scripts: { ignored: 'changed' },
      devDependencies: { tool: '99.0.0' },
    }),
  );
  f.write(
    'pnpm-lock.yaml',
    JSON.stringify({
      ...f.lock,
      packages: { ...f.lock.packages, 'tool@99.0.0': { unrelated: true } },
      importers: { ...f.lock.importers, '.': { devDependencies: { tool: { version: '99.0.0' } } } },
    }),
  );
  f.write(OUTPUT, '{"digest":"not-an-input"}');
  expect(engineIdentity(f.root).implementation).toEqual(before);
});
it('normalizes CRLF and lock key/enumeration order', () => {
  const f = fixture(),
    before = engineIdentity(f.root);
  for (const [path] of before.payload.sources)
    f.write(path!, f.read(path!).replaceAll('\n', '\r\n'));
  f.write('pnpm-lock.yaml', JSON.stringify(Object.fromEntries(Object.entries(f.lock).reverse())));
  expect(engineIdentity(f.root)).toEqual(before);
});
it.each(['import { type Hidden }', 'export { type Hidden }'])(
  'includes side effects retained by %s',
  (declaration) => {
    const f = fixture();
    f.write(ENTRY, f.read(ENTRY) + `${declaration} from './types.ts';\n`);
    const before = engineIdentity(f.root);
    expect(before.payload.sources.map(([path]) => path)).toContain(`${SPATIAL}/types.ts`);
    f.write(`${SPATIAL}/types.ts`, 'export type Hidden = number; export default 2;\n');
    expect(engineIdentity(f.root).implementation.digest).not.toBe(before.implementation.digest);
  },
);
it('includes changed integrity and resolved runtime versions', () => {
  const f = fixture(),
    before = engineIdentity(f.root).implementation.digest;
  f.lock.packages['zod@4.6.5'].resolution.integrity =
    `sha512-${Buffer.alloc(64, 2).toString('base64')}`;
  f.saveLock();
  const changed = engineIdentity(f.root).implementation.digest;
  expect(changed).not.toBe(before);
  f.write(
    'node_modules/zod/package.json',
    JSON.stringify({
      name: 'zod',
      version: '4.6.6',
      type: 'module',
      exports: { '.': './index.ts' },
    }),
  );
  f.write(`${DOMAIN}/package.json`, f.read(`${DOMAIN}/package.json`).replaceAll('4.6.5', '4.6.6'));
  f.write('pnpm-lock.yaml', f.read('pnpm-lock.yaml').replaceAll('4.6.5', '4.6.6'));
  expect(engineIdentity(f.root).implementation.digest).not.toBe(changed);
});
it('refuses stale output without rewriting it', () => {
  const f = fixture(),
    identity = engineIdentity(f.root).implementation;
  expect(() => verifyIdentity(f.root, identity)).toThrow(/Stale/);
  expect(f.read(OUTPUT)).toBe('{}\n');
  f.write(OUTPUT, JSON.stringify(identity, null, 2) + '\n');
  expect(() => verifyIdentity(f.root, identity)).not.toThrow();
});
it.each([
  ['missing source', `${SPATIAL}/lazy.ts`, null],
  ['invalid syntax', `${SPATIAL}/lazy.ts`, 'export const value = ;'],
  [
    'nonliteral import',
    `${SPATIAL}/lazy.ts`,
    'const path="./nested.ts"; export const load=()=>import(path);',
  ],
  ['unresolved dependency', `${SPATIAL}/lazy.ts`, "export * from 'missing-dependency';"],
  ['CommonJS require', `${SPATIAL}/lazy.ts`, "export const value = require('./nested.ts');"],
  ['import equals', `${SPATIAL}/lazy.ts`, "import value = require('./nested.ts'); export {value};"],
  ['missing integrity', 'pnpm-lock.yaml', 'missing-integrity'],
  ['invalid YAML', 'pnpm-lock.yaml', 'bad: ['],
  ['unsupported lock version', 'pnpm-lock.yaml', '{"lockfileVersion":"8.0"}'],
  ['missing physics bytes', `${RAPIER}/dist/rapier_wasm3d_bg.wasm`, null],
  [
    'wrong installed version',
    'node_modules/zod/package.json',
    '{"name":"zod","version":"0.0.0","exports":{".":"./index.ts"}}',
  ],
  ['wrong Node', '.node-version', '0.0.0\n'],
  ['non-ESM package', `${ENGINE}/package.json`, '{"type":"commonjs"}'],
])('fails closed for %s', (_label, path, content) => {
  const f = fixture();
  if (content === null) rmSync(join(f.root, path));
  else if (content === 'missing-integrity')
    f.write(path, JSON.stringify(f.lock).replaceAll('integrity', 'absent'));
  else f.write(path, content);
  expect(() => engineIdentity(f.root)).toThrow();
  expect(f.read(OUTPUT)).toBe('{}\n');
});
it.each([
  'packages/samples/src/foreign.ts',
  'apps/api/src/foreign.ts',
  `${DOMAIN}/src/spatial/replay.ts`,
])('rejects execution leakage to %s', (path) => {
  const f = fixture();
  f.write(path, 'export const forbidden=1;');
  const relative = path.startsWith('apps/')
    ? '../../../../apps/api/src/foreign.ts'
    : path.startsWith('packages/samples/')
      ? '../../../samples/src/foreign.ts'
      : '../../../domain/src/spatial/replay.ts';
  f.write(`${SPATIAL}/lazy.ts`, `export * from '${relative}';`);
  expect(() => engineIdentity(f.root)).toThrow(/Non-execution/);
});
