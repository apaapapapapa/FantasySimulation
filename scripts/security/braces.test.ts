import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

type Options = { maxDepth?: number; escapeInvalid?: boolean };
type Braces = Record<
  'parse' | 'compile' | 'expand' | 'stringify',
  (input: unknown, options?: Options) => unknown
>;

// Resolve through both real release consumers, not a separate test dependency.
const consumers = ['semantic-release', '@semantic-release/commit-analyzer'];
const resolved = consumers.map((name) => {
  const consumer = createRequire(import.meta.resolve(name));
  return createRequire(consumer.resolve('micromatch')).resolve('braces');
});
const require = createRequire(import.meta.url);
const braces = require(resolved[0]!) as Braces;
const methods = ['parse', 'compile', 'expand', 'stringify'] as const;

function nested(depth: number, open = '{', close = '}'): string {
  return open.repeat(depth) + 'a,b' + close.repeat(depth);
}

await test('both release consumers resolve the same patched braces implementation', () => {
  assert.equal(new Set(resolved).size, 1);
  for (const path of resolved) {
    assert.throws(() => (require(path) as Braces).compile(nested(101)), /exceeds max depth/);
  }
});

await test('all string entry points bound braces, parentheses and mixed nesting', () => {
  for (const method of methods) {
    for (const [open, close] of [
      ['{', '}'],
      ['(', ')'],
      ['{(', ')}'],
    ]) {
      assert.ok(open && close);
      const boundary = Math.floor(100 / open.length);
      assert.doesNotThrow(() => braces[method](nested(boundary, open, close)));
      for (const depth of [boundary + 1, 2000]) {
        assert.throws(() => braces[method](nested(depth, open, close)), {
          name: 'SyntaxError',
          message: /exceeds max depth/,
        });
      }
    }
  }
});

await test('depth options cannot disable the cap and preserve stricter fractional limits', () => {
  for (const method of methods) {
    for (const maxDepth of [101, 1e9, Infinity, NaN]) {
      assert.throws(() => braces[method](nested(101), { maxDepth }), /exceeds max depth/);
    }
    assert.doesNotThrow(() => braces[method]('{a,b}', { maxDepth: 1.5 }));
    assert.throws(() => braces[method]('{{a,b},c}', { maxDepth: 1.5 }), /exceeds max depth/);
  }
});

await test('caller supplied ASTs cannot bypass recursive walker limits', () => {
  for (const method of ['compile', 'expand', 'stringify'] as const) {
    let ast: { type: string; nodes?: unknown[]; value?: string } = { type: 'text', value: 'a' };
    for (let depth = 0; depth < 2000; depth++) ast = { type: 'brace', nodes: [ast] };
    assert.throws(() => braces[method]({ type: 'root', nodes: [ast] }), {
      name: 'RangeError',
      message: /exceeds max depth/,
    });
    const cyclic = { type: 'root', nodes: [] as unknown[] };
    cyclic.nodes.push(cyclic);
    assert.throws(() => braces[method](cyclic), /exceeds max depth/);
  }
});

await test('expansion rejects cyclic parent chains within a bounded execution', () => {
  for (const length of [1, 2]) {
    const ast: { type: string; nodes: unknown[]; parent?: unknown } = {
      type: 'paren',
      nodes: [{ type: 'text', value: 'a' }],
    };
    ast.parent = length === 1 ? ast : { type: 'paren', parent: ast };
    assert.throws(
      () => runInNewContext('expand(ast)', { expand: braces.expand, ast }, { timeout: 1000 }),
      { name: 'RangeError', message: 'AST parent chain contains a cycle' },
    );
  }
});

await test('ordinary lists, ranges, nested patterns and escaped text retain their outputs', () => {
  assert.equal(braces.compile('release/{alpha,beta}/{01..03}'), 'release/(alpha|beta)/(0[1-3])');
  assert.deepEqual(braces.expand('v{1..5..2}/{a,{b,c}}'), [
    'v1/a',
    'v1/b',
    'v1/c',
    'v3/a',
    'v3/b',
    'v3/c',
    'v5/a',
    'v5/b',
    'v5/c',
  ]);
  for (const pattern of ['{{a}}', '{a,{b}}', '{{x}y}', '{a,{b,{c}}', '{}{a}']) {
    assert.equal(braces.stringify(braces.parse(pattern), { escapeInvalid: true }), pattern);
  }
  assert.deepEqual(braces.expand('foo/({a,b})'), ['foo/(a)', 'foo/(b)']);
  assert.deepEqual(braces.expand('\\{a,b\\}'), ['{a,b}']);
  assert.deepEqual(braces.expand('"' + nested(2000) + '"'), [nested(2000)]);
});

await test('semantic-release keeps main branch selection and conventional release levels', async () => {
  const releaseRequire = createRequire(import.meta.resolve('semantic-release'));
  const match = releaseRequire('micromatch') as (names: string[], pattern: string) => string[];
  assert.deepEqual(match(['main', 'feature/main', 'next'], 'main'), ['main']);
  const { analyzeCommits } = (await import(
    import.meta.resolve('@semantic-release/commit-analyzer')
  )) as {
    analyzeCommits: (
      config: { preset: string },
      context: {
        cwd: string;
        commits: { hash: string; message: string }[];
        logger: { log: () => void };
      },
    ) => Promise<string | null>;
  };
  for (const [message, expected] of [
    ['docs: clarify instructions', null],
    ['fix: bound dependency recursion', 'patch'],
    ['feat: add replay view', 'minor'],
    ['feat!: change contract\n\nBREAKING CHANGE: previous contract removed', 'major'],
  ] as const) {
    assert.equal(
      await analyzeCommits(
        { preset: 'conventionalcommits' },
        {
          cwd: process.cwd(),
          commits: [{ hash: '1'.repeat(40), message }],
          logger: { log: () => {} },
        },
      ),
      expected,
    );
  }
});
