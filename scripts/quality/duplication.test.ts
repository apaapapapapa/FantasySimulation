import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vite-plus/test';
import { duplication, DUPLICATION_POLICY } from './duplication.ts';
import { firstPartyTypeScript, qualityPaths } from './files.ts';
import { createTestProject } from './test-support/project.ts';

const projects: ReturnType<typeof createTestProject>[] = [];
function project(files: Record<string, string>) {
  const value = createTestProject(files);
  projects.push(value);
  return value;
}
afterEach(() => {
  for (const value of projects.splice(0)) value.dispose();
});
const calculation = `export function calculate(values: number[]) {
  let total = 0;
  for (const value of values) {
    if (value < 0) {
      total -= value * 2;
    } else {
      total += value + 3;
    }
  }
  const label = 'total';
  return { label, total };
}`;

it.each([
  ['apps/api/src/a.ts', 'apps/api/src/b.ts'],
  ['packages/engine/src/a.ts', 'packages/engine/src/a.test.ts'],
  ['scripts/harness/a.ts', 'scripts/quality/test-support/b.ts'],
])('rejects cross-file clones including tests and helpers: %s / %s', (a, b) => {
  const f = project({ [a]: calculation, [b]: calculation });
  const findings = duplication(f.root, f.paths);
  expect(findings).toHaveLength(1);
  expect([findings[0]!.source.path, findings[0]!.destination.path].sort()).toEqual([a, b].sort());
  expect(findings[0]).toMatchObject({ source: { startLine: 1, endLine: 11 } });
  expect(findings[0]!.nodes).toBeGreaterThanOrEqual(DUPLICATION_POLICY.minNodes);
  expect(duplication(f.root, [...f.paths].reverse())).toEqual(findings);
});
it('ignores comments, whitespace and quote style, not the code they surround', () => {
  const f = project({
    'a.ts': calculation,
    'b.ts': '// independently copied\n' + calculation.replaceAll("'", '"').replaceAll('  ', '\t'),
  });
  const [finding] = duplication(f.root, f.paths);
  expect(finding?.source.startLine).toBe(1);
  expect(finding?.destination.startLine).toBe(2);
});
it('detects nonoverlapping same-file copies without reporting every sliding window', () => {
  const f = project({ 'a.ts': calculation + '\n' + calculation.replace('calculate', 'copied') });
  const findings = duplication(f.root, f.paths);
  expect(findings).toHaveLength(1);
  expect(findings[0]!.source.path).toBe(findings[0]!.destination.path);
  expect(findings[0]!.source.endLine).toBeLessThan(findings[0]!.destination.startLine);
});
it('does not treat imports, small idioms, fixture strings or short line spans as clones', () => {
  const small = 'export const add = (a: number, b: number) => a + b;';
  const f = project({
    'a.ts': small,
    'b.ts': small,
    'imports.ts': Array.from({ length: 20 }, (_, i) => `import {x${i}} from './x${i}.ts';`).join(
      '\n',
    ),
    'fixture.ts': `export const fixture = ${JSON.stringify(calculation + '\n' + calculation)};`,
    'compact.ts': calculation.replaceAll('\n', ' ') + calculation.replaceAll('\n', ' '),
  });
  expect(duplication(f.root, f.paths)).toEqual([]);
});
it('preserves literal values and operators rather than merging different behavior', () => {
  const f = project({
    'a.ts': calculation,
    'b.ts': calculation
      .replace('value < 0', 'value > 0')
      .replace('value * 2', 'value / 2')
      .replace('value + 3', 'value - 3'),
  });
  expect(duplication(f.root, f.paths)).toEqual([]);
});
it('parses TSX and template/regex syntax using the pinned TypeScript parser', () => {
  const jsx = calculation.replace(
    "const label = 'total';",
    'const label = <section>{`total ${total}`}</section>;',
  );
  const f = project({
    'a.tsx': jsx,
    'b.tsx': jsx,
    'regexp.ts': 'export const pattern = /[{}]\\/\\/.*$/;',
  });
  expect(duplication(f.root, f.paths)).toHaveLength(1);
});
it.each([
  ['empty', {}],
  ['invalid syntax', { 'a.ts': 'export const = ;' }],
  ['missing file', { 'a.ts': calculation }],
  ['duplicate paths', { 'a.ts': calculation }],
])('fails closed on %s coverage', (reason, files) => {
  const f = project(files);
  const paths =
    reason === 'missing file'
      ? ['missing.ts']
      : reason === 'duplicate paths'
        ? ['a.ts', 'a.ts']
        : f.paths;
  expect(() => duplication(f.root, paths)).toThrow(Error);
});
it('fails closed when repetitive input exhausts the comparison budget', () => {
  const f = project({ 'a.ts': 'export {};\n' + 'work(value);\n'.repeat(1500) });
  expect(() => duplication(f.root, f.paths)).toThrow(/budget exceeded/);
});
it('covers untracked TS and TSX locally without scanning ignored output or node_modules', () => {
  const f = project({
    '.gitignore': '.generated/\nnode_modules/\n',
    'a.ts': calculation,
    'new.test.tsx': calculation,
    '.generated/c.ts': calculation,
    'node_modules/d.ts': calculation,
  });
  execFileSync('git', ['init', '--quiet'], { cwd: f.root });
  execFileSync('git', ['add', 'a.ts'], { cwd: f.root });
  const paths = qualityPaths(f.root);
  expect(firstPartyTypeScript(paths)).toEqual(['a.ts', 'new.test.tsx']);
  expect(duplication(f.root, paths)).toHaveLength(1);
});

it('retains unary operators and declaration kinds that are not child nodes', () => {
  const values = (sign: string, declaration: string) =>
    Array.from({ length: 12 }, (_, i) => `${declaration} item${i} = ${sign}input${i};`).join('\n');
  const f = project({ 'a.ts': values('+', 'let'), 'b.ts': values('-', 'const') });
  expect(duplication(f.root, f.paths)).toEqual([]);
});
