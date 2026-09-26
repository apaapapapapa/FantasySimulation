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
      tests: ['feature.test.ts'],
    },
  };
}
function inspect(code: string, contract = coverage(), expected = ['effect:example']) {
  const project = createTestProject({
    [path]: code,
    'feature.test.ts': 'declare function expect(x: unknown): void; expect(1);',
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

it.each([
  '() => {}',
  '() => undefined',
  '() => false',
  '() => { return; }',
  '() => { const result = false; return result; }',
  '() => { const a = 0; const b = (a + 1); return b; }',
  '() => { const a = undefined; const b = a; return b; }',
  '() => { return false; performWork(); }',
])('rejects a claimed implemented handler %s', (body) => {
  expect(inspect(`const work = ${body};`)).toHaveLength(CAPABILITY_ROLES.length);
});

it('resolves aliases instead of treating an empty function name as implementation', () => {
  expect(inspect('const empty = () => {}; const work = empty;')).toHaveLength(5);
  expect(inspect('const work = (n: number) => n + 1;')).toEqual([]);
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
