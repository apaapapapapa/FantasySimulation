import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTestProject } from '../../quality/test-support/project.ts';
import { ENTRY, OUTPUT } from '../closure.ts';

export const ENGINE = 'packages/engine';
export const DOMAIN = 'packages/domain';
export const SPATIAL = `${ENGINE}/src/spatial`;
export const RAPIER = 'node_modules/@dimforge/rapier3d-compat';
export const INTEGRITY = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
export function identityProject() {
  const manifest = (name: string, version: string, dependencies = {}) =>
    JSON.stringify({
      name,
      version,
      type: 'module',
      exports: { '.': './index.ts' },
      dependencies,
    });
  const lock = {
    lockfileVersion: '9.0',
    importers: {
      [ENGINE]: {
        dependencies: {
          '@fantasy/domain': { specifier: 'workspace:*', version: 'link:../domain' },
          '@dimforge/rapier3d-compat': { specifier: '0.20.0', version: '0.20.0' },
        },
      },
      [DOMAIN]: { dependencies: { zod: { specifier: '4.6.5', version: '4.6.5' } } },
    },
    packages: {
      '@dimforge/rapier3d-compat@0.20.0': { resolution: { integrity: INTEGRITY } },
      'zod@4.6.5': { resolution: { integrity: INTEGRITY } },
    },
    snapshots: { '@dimforge/rapier3d-compat@0.20.0': {}, 'zod@4.6.5': {} },
  };
  const project = createTestProject({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        target: 'ES2023',
        verbatimModuleSyntax: true,
        resolveJsonModule: true,
        noEmit: true,
      },
      include: ['packages/**/*.ts'],
    }),
    '.node-version': `${process.versions.node}\n`,
    'package.json': manifest('fixture', '1.0.0'),
    'pnpm-lock.yaml': JSON.stringify(lock),
    [`${ENGINE}/package.json`]: manifest('@fantasy/engine', '1.0.0', {
      '@fantasy/domain': 'workspace:*',
      '@dimforge/rapier3d-compat': '0.20.0',
    }),
    [`${DOMAIN}/package.json`]: JSON.stringify({
      name: '@fantasy/domain',
      type: 'module',
      exports: { './spatial/execution': './src/spatial/execution.ts' },
      dependencies: { zod: '4.6.5' },
    }),
    [ENTRY]:
      "export * from './nested.ts';\nimport './boot.ts';\nexport const load = () => import('./lazy.ts');\nexport type { Hidden } from './types.ts';\n",
    [`${SPATIAL}/nested.ts`]:
      "export { value } from '@fantasy/domain/spatial/execution';\nexport { physics } from '@dimforge/rapier3d-compat';\nimport profile from './profile.json' with {type:'json'};\nimport table from './sine-table.json' with {type:'json'};\nexport const data = [profile,table];\n",
    [`${SPATIAL}/boot.ts`]: 'const boot = 1;\n',
    [`${SPATIAL}/lazy.ts`]: "export { value } from './nested.ts';\n",
    [`${SPATIAL}/types.ts`]: 'export type Hidden = string;\n',
    [`${SPATIAL}/profile.json`]: '{"step":20}\n',
    [`${SPATIAL}/sine-table.json`]: '[0,1,0,-1]\n',
    [`${DOMAIN}/src/spatial/execution.ts`]: "export { value } from 'zod';\n",
    [OUTPUT]: '{}\n',
    [`${RAPIER}/package.json`]: manifest('@dimforge/rapier3d-compat', '0.20.0'),
    [`${RAPIER}/index.ts`]: 'export const physics = 1;\n',
    [`${RAPIER}/dist/rapier_wasm3d_bg.wasm`]: 'fixture wasm bytes',
    [`${RAPIER}/dist/rapier.mjs`]: 'export const binding = 1;\n',
    'node_modules/zod/package.json': manifest('zod', '4.6.5'),
    'node_modules/zod/index.ts': 'export const value = 1;\n',
  });
  const link = join(project.root, ENGINE, 'node_modules/@fantasy/domain');
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(join(project.root, DOMAIN), link, process.platform === 'win32' ? 'junction' : 'dir');
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(project.root, path)), { recursive: true });
    writeFileSync(join(project.root, path), content);
  };
  const read = (path: string) => readFileSync(join(project.root, path), 'utf8');
  return {
    ...project,
    lock,
    read,
    write,
    saveLock: () => write('pnpm-lock.yaml', JSON.stringify(lock)),
  };
}
