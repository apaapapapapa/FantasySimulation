import { expect, it } from 'vite-plus/test';
import { withSources } from './ast.ts';
import { unsupportedTypeScriptModules } from './files.ts';
import { determinism } from './determinism.ts';
import { createTestProject } from './test-support/project.ts';

function cases(codes: string[]) {
  const paths = codes.map((_, i) => `packages/engine/src/example${i}.ts`);
  const project = createTestProject(
    Object.fromEntries(paths.map((path, i) => [path, codes[i] + '\nexport {};'])),
  );
  try {
    return withSources(project.root, paths, (files, _options, checker) =>
      paths.map((path, i) => [codes[i]!, determinism(path, files.get(path)!, checker)] as const),
    );
  } finally {
    project.dispose();
  }
}

it.each([
  ['packages/engine/src/spatial/world/physics.ts', true],
  ['packages/engine/src/spatial/physics.ts', false],
  ['packages/engine/src/spatial/world/other.ts', false],
] as const)('keeps Rapier isolated at the relocated adapter: %s', (path, allowed) => {
  const project = createTestProject({
    [path]: "import RAPIER from '@dimforge/rapier3d-compat'; export const adapter = RAPIER;",
  });
  try {
    const findings = withSources(project.root, [path], (files, _options, checker) =>
      determinism(path, files.get(path)!, checker),
    );
    expect(findings.some((finding) => finding.rule === 'engine-dependency-policy')).toBe(!allowed);
  } finally {
    project.dispose();
  }
});

it.each(
  cases([
    'Math.random();',
    "Math['random']();",
    'const {random}=Math; random();',
    "const key='random'; Math[key]();",
    'const m=Math; m.random();',
    'Date.now();',
    'new Date();',
    'const clock=Date; clock.now();',
    'performance.now();',
    "fetch('https://example.invalid');",
    'globalThis.Date.now();',
    'process.hrtime();',
    'crypto.randomUUID();',
    "navigator.sendBeacon('https://example.invalid');",
    'localStorage.getItem("x");',
    'new EventSource("/events");',
    'import.meta.url;',
    'document.cookie;',
    'new Worker("worker.ts");',
    'indexedDB.open("db");',
    'Atomics.wait(a, 0, 0);',
    'setTimeout(() => {}, 0);',
    "new Function('return Date.now()')();",
  ]),
)('rejects implicit randomness and environment access: %s', (_code, findings) => {
  expect(findings).not.toEqual([]);
});

it('allows deterministic math, explicit local inputs, property names and pure hash aliases', () => {
  expect(
    cases([
      `
    import {createHash as hash} from 'node:crypto';
    const input={self:{id:1}};
    function policy(self:{id:number}) { return Math.floor(self.id) + input.self.id; }
    hash('sha256').update('constant').digest('hex');
    policy(input.self);
  `,
    ])[0]![1],
  ).toEqual([]);
});

it.each(
  cases([
    "import {randomBytes} from 'node:crypto';",
    "import * as crypto from 'node:crypto';",
    "import crypto from 'node:crypto';",
    "import 'node:crypto';",
    "export {randomUUID} from 'node:crypto';",
    "export * from 'node:crypto';",
    "const c=await import('node:crypto');",
    "const c=require('node:crypto');",
  ]),
)('limits the crypto exception to static named createHash imports: %s', (_code, findings) => {
  expect(findings.some((f) => f.rule === 'pure-hash-only')).toBe(true);
});

it.each(
  cases(
    [
      'node:fs',
      'node:http',
      'node:sqlite',
      'crypto',
      'undici',
      'better-sqlite3',
      '@fantasy/domain-unsafe',
    ].map((module) => `import * as imported from '${module}';`),
  ),
)(
  'rejects network, database and unreviewed SDK imports at the engine boundary: %s',
  (_code, findings) => {
    expect(findings.some((f) => f.rule === 'engine-dependency-policy')).toBe(true);
  },
);

it('rejects unsupported TypeScript module variants instead of omitting their execution', () => {
  expect(
    unsupportedTypeScriptModules([
      'packages/engine/src/hidden.mts',
      'packages/engine/src/hidden.cts',
      'packages/engine/src/safe.ts',
      'node_modules/x/index.mts',
    ]),
  ).toEqual(['packages/engine/src/hidden.mts', 'packages/engine/src/hidden.cts']);
});
