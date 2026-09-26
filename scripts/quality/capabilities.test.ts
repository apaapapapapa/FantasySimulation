import { expect, it } from 'vite-plus/test';
import { withSources } from './ast.ts';
import { createTestProject } from './test-support/project.ts';
import { capabilityCoverage, inspectCapabilities } from './capabilities.ts';
import { CAPABILITY_ROLES, type CapabilityCoverage } from './capability-contract.ts';
import { qualityPaths } from './files.ts';

const path = 'feature.ts';
function coverage(): Record<string, CapabilityCoverage> {
  const responsibility = { status: 'implemented' as const, owner: { path, symbol: 'work' } };
  return {
    'effect:example': {
      roles: {
        resolution: responsibility,
        assessment: responsibility,
        observation: responsibility,
        replay: responsibility,
        display: responsibility,
      },
      tests: [{ path: 'feature.test.ts', name: 'handles example' }],
    },
  };
}
function inspect(
  code: string,
  contract = coverage(),
  expected = ['effect:example'],
  testSource = "import { it, expect } from 'vite-plus/test'; it('handles example', () => { const example = 1; expect(example).toBe(1); });",
) {
  const project = createTestProject({
    [path]: code,
    'feature.test.ts': testSource,
  });
  try {
    return withSources(project.root, [path, 'feature.test.ts'], (files) =>
      inspectCapabilities(files, contract, expected),
    );
  } finally {
    project.dispose();
  }
}

it('requires every current effect and shape to have live owners and behavioral test files', () => {
  expect(capabilityCoverage(process.cwd(), qualityPaths(process.cwd()))).toEqual([]);
});

it('rejects absent test files, empty coverage and files without assertions', () => {
  const code = 'const work = (n: number) => n + 1;';
  for (const tests of [[], [{ path: 'missing.test.ts', name: 'handles example' }]]) {
    const contract = coverage();
    contract['effect:example']!.tests = tests;
    expect(inspect(code, contract).some((finding) => finding.role === 'tests')).toBe(true);
  }
  expect(
    inspect(code, coverage(), ['effect:example'], 'const value = 1;').some(
      (finding) => finding.role === 'tests',
    ),
  ).toBe(true);
});

it('requires a unique active named test with a kind reference and an assertion in its callback', () => {
  for (const source of [
    "it('unrelated', () => { expect('example').toBe('example'); });",
    "it('handles example', () => { expect(1).toBe(1); });",
    "it('handles example', () => { const example = null; expect(true).toBe(true); });",
    "const example = () => 1; const other = () => true; it('handles example', () => { expect(other()).toBe(true); });",
    "expect('example').toBe('example'); it('handles example', () => {});",
    "it.skip('handles example', () => { expect('example').toBe('example'); });",
    "describe.skip('group', () => { it('handles example', () => { expect('example').toBe('example'); }); });",
    "it('handles example', () => { expect('example'); });",
    "it('handles example', () => { expect('example').toBe('example'); }); it('handles example', () => {});",
  ]) {
    expect(
      inspect('const work = (n: number) => n + 1;', coverage(), ['effect:example'], source).some(
        (finding) => finding.role === 'tests',
      ),
    ).toBe(true);
  }
});

it('follows capability results through helper calls and local aliases into an assertion', () => {
  const source =
    "function example() { return 1; } it('handles example', () => { const value = example(); const result = { value }; expect(result).toEqual({ value: 1 }); });";
  expect(
    inspect('const work = (n: number) => n + 1;', coverage(), ['effect:example'], source),
  ).toEqual([]);
});

it.each([
  '() => {}',
  '() => undefined',
  '() => false',
  '() => Infinity',
  '() => NaN',
  '() => Number.NaN',
  '() => Number.POSITIVE_INFINITY',
  '() => Number["NEGATIVE_INFINITY"]',
  '() => Math.PI',
  '() => globalThis.Number.MAX_SAFE_INTEGER',
  '() => globalThis["Infinity"]',
  '() => { const value = Number.NaN; const result = { value }; return result; }',
  '() => void 0',
  '() => ({})',
  '() => []',
  '() => ({ nested: [0, { value: false }] })',
  '() => { const result = {}; return result; }',
  '() => { const result = []; return result; }',
  '() => { const value = false; const result = { value, list: [value] }; return result; }',
  '() => ({ ...{ value: false }, ["fixed"]: [...[0], ,] })',
  '() => `constant`',
  '() => ({ value: 1n, pattern: /fixed/ })',
  '() => ({ value: true ? [] : {} })',
  '() => ({ value: `fixed${1}` })',
  '() => { const result = void 0; return result; }',
  '() => { return; }',
  '() => { const result = false; return result; }',
  '() => { const a = 0; const b = (a + 1); return b; }',
  '() => { const a = undefined; const b = a; return b; }',
  '() => { return false; performWork(); }',
  '() => { if (false) performWork(); }',
  '() => { if (0) performWork(); }',
  '() => { if (NaN) performWork(); }',
  '() => { if (Number.NaN) performWork(); }',
  '() => { if (1 === 2) performWork(); }',
  '() => { const enabled = false; if (enabled) performWork(); }',
  '() => { if (!true) { performWork(); } }',
  '() => { if (true) return; performWork(); }',
  '() => { if (true) { return false; } else performWork(); }',
  '() => { while (false) performWork(); }',
  '() => { for (let i = 0; false; i++) performWork(); }',
  '() => { { return; } performWork(); }',
  '() => { false; NaN; }',
  '() => false && performWork()',
  '() => true || performWork()',
  '() => { const enabled = false; return enabled && performWork(); }',
  '() => false ? performWork() : undefined',
  '() => true ? undefined : performWork()',
])('rejects a claimed implemented handler %s', (body) => {
  expect(inspect(`const work = ${body};`)).toHaveLength(CAPABILITY_ROLES.length);
});

it('resolves aliases instead of treating an empty function name as implementation', () => {
  expect(inspect('const empty = () => {}; const work = empty;')).toHaveLength(5);
  expect(inspect('const work = (n: number) => n + 1;')).toEqual([]);
  expect(inspect('const work = (n: number) => { const result = n + 1; return result; };')).toEqual(
    [],
  );
  expect(inspect('const work = (n: number) => void console.log(n);')).toEqual([]);
  expect(inspect('const work = (n: number) => ({ value: n });')).toEqual([]);
  expect(inspect('const work = (n: number) => [n];')).toEqual([]);
  expect(inspect('const work = (n: number) => ({ value: console.log(n) });')).toEqual([]);
  expect(inspect('const work = (n: number) => ({ [console.log(n)]: false });')).toEqual([]);
  expect(inspect('const work = (n: number) => ({ value: n ? [] : {} });')).toEqual([]);
  expect(inspect('const work = (n: number) => ({ value: `item${n}` });')).toEqual([]);
  expect(inspect('const work = (n: number) => Number.isNaN(n);')).toEqual([]);
  expect(inspect('const work = (record: { NaN: number }) => record.NaN;')).toEqual([]);
  expect(inspect('const work = (NaN: number) => NaN;')).toEqual([]);
  expect(inspect('const work = (Number: { NaN: number }) => Number.NaN;')).toEqual([]);
  expect(inspect('const work = ({ Infinity }: { Infinity: number }) => Infinity;')).toEqual([]);
  expect(
    inspect('const work = (n: number) => { const Number = { NaN: n }; return Number.NaN; };'),
  ).toEqual([]);
  for (const body of [
    '() => { if (true) performWork(); }',
    '() => { if (false) return; else performWork(); }',
    '() => { if (false) performWork(); performOtherWork(); }',
    '() => { do { performWork(); } while (false); }',
    '() => { for (performWork(); false;) {} }',
    '() => { if ({ value: performWork() }) {} }',
    '() => true && performWork()',
    '() => false || performWork()',
    '() => true ? performWork() : undefined',
    '() => false ? undefined : performWork()',
  ])
    expect(inspect(`const work = ${body};`)).toEqual([]);
});

it('requires explicit, live delegation and rejects missing responsibilities/new schema kinds', () => {
  const contract = coverage();
  contract['effect:example']!.roles.resolution = {
    status: 'delegated',
    owner: { path, symbol: 'handlers', member: 'example' },
    delegate: { path, symbol: 'apply' },
    reason: 'The transaction owns this effect',
  };
  const code = 'const work = (n: number) => n + 1; const handlers = { example: () => {} };';
  expect(inspect(code, contract).some((finding) => finding.role === 'resolution')).toBe(true);
  expect(inspect(code + 'function apply(n: number) { return n + 1; }', contract)).toEqual([]);
  contract['effect:example']!.roles.display = { status: 'unsupported', reason: 'Not implemented' };
  const findings = inspect(code, contract, ['effect:example', 'effect:new']);
  expect(findings.some((finding) => finding.role === 'display')).toBe(true);
  expect(findings.some((finding) => finding.capability === 'effect:new')).toBe(true);
});
