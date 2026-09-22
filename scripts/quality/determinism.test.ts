import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { withSources } from './ast.ts';
import { determinism } from './determinism.ts';

function inspect(code: string) {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-determinism-'));
  const path = 'packages/engine/src/example.ts';
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
    writeFileSync(join(root, path), code + '\nexport {};');
    return withSources(root, [path], (files, _options, checker) =>
      determinism(path, files.get(path)!, checker),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('rejects direct, computed and aliased implicit randomness and environment access', () => {
  for (const code of [
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
    'Atomics.wait(a, 0, 0);',
    'setTimeout(() => {}, 0);',
    "new Function('return Date.now()')();",
  ])
    expect(inspect(code), code).not.toEqual([]);
});

it('allows deterministic math, explicit local inputs, property names and pure hash aliases', () => {
  expect(
    inspect(`
    import {createHash as hash} from 'node:crypto';
    const input={self:{id:1}};
    function policy(self:{id:number}) { return Math.floor(self.id) + input.self.id; }
    hash('sha256').update('constant').digest('hex');
    policy(input.self);
  `),
  ).toEqual([]);
});

it('limits the crypto exception to static named createHash imports', () => {
  for (const code of [
    "import {randomBytes} from 'node:crypto';",
    "import * as crypto from 'node:crypto';",
    "import crypto from 'node:crypto';",
    "import 'node:crypto';",
    "export {randomUUID} from 'node:crypto';",
    "export * from 'node:crypto';",
    "const c=await import('node:crypto');",
    "const c=require('node:crypto');",
  ])
    expect(
      inspect(code).some((f) => f.rule === 'pure-hash-only'),
      code,
    ).toBe(true);
});

it('rejects network, database and unreviewed SDK imports at the engine boundary', () => {
  for (const module of [
    'node:fs',
    'node:http',
    'node:sqlite',
    'crypto',
    'undici',
    'better-sqlite3',
    '@fantasy/domain-unsafe',
  ])
    expect(
      inspect(`import * as imported from '${module}';`).some(
        (f) => f.rule === 'engine-dependency-policy',
      ),
    ).toBe(true);
});
