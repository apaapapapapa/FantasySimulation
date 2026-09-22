import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { withSources } from './ast.ts';
import { unsupportedTypeScriptModules } from './files.ts';
import { determinism } from './determinism.ts';

function cases(codes: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-determinism-'));
  const paths = codes.map((_, i) => `packages/engine/src/example${i}.ts`);
  try {
    mkdirSync(join(root, 'packages/engine/src'), { recursive: true });
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noEmit: true,
        },
        include: ['packages/**/*.ts'],
      }),
    );
    for (const [i, path] of paths.entries())
      writeFileSync(join(root, path), codes[i] + '\nexport {};');
    return withSources(root, paths, (files, _options, checker) =>
      paths.map((path, i) => [codes[i]!, determinism(path, files.get(path)!, checker)] as const),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('rejects direct, computed and aliased implicit randomness and environment access', () => {
  for (const [code, findings] of cases([
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
  ]))
    expect(findings, code).not.toEqual([]);
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

it('limits the crypto exception to static named createHash imports', () => {
  for (const [code, findings] of cases([
    "import {randomBytes} from 'node:crypto';",
    "import * as crypto from 'node:crypto';",
    "import crypto from 'node:crypto';",
    "import 'node:crypto';",
    "export {randomUUID} from 'node:crypto';",
    "export * from 'node:crypto';",
    "const c=await import('node:crypto');",
    "const c=require('node:crypto');",
  ]))
    expect(
      findings.some((f) => f.rule === 'pure-hash-only'),
      code,
    ).toBe(true);
});

it('rejects network, database and unreviewed SDK imports at the engine boundary', () => {
  const modules = [
    'node:fs',
    'node:http',
    'node:sqlite',
    'crypto',
    'undici',
    'better-sqlite3',
    '@fantasy/domain-unsafe',
  ];
  for (const [code, findings] of cases(
    modules.map((module) => `import * as imported from '${module}';`),
  ))
    expect(
      findings.some((f) => f.rule === 'engine-dependency-policy'),
      code,
    ).toBe(true);
});

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
