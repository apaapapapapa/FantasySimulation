import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renovateOutcome, toolchainOutcome } from './toolchain.ts';
import { object } from './common.ts';

const manifest = {
  devDependencies: { 'vite-plus': '0.3.3' },
  packageManager: 'pnpm@11.19.0',
  engines: { node: '>=24.19.0 <25' },
};
const workspace =
  'overrides:\n  vite: npm:@voidzero-dev/vite-plus-core@0.3.3\n  vitest: 4.1.11\npeerDependencyRules:\n  allowedVersions:\n    vite: 0.3.3\n';
const pair = {
  vitePlus: '0.3.3',
  vitest: '4.1.11',
  evidence: 'Reviewed fixture for version-coupling regression tests.',
};

await test('current exact toolchain pins satisfy their compatibility contract', () => {
  assert.equal(toolchainOutcome(manifest, workspace, '24.19.0', pair).status, 'pass');
});

await test('Vite alias, peer, Vitest and reviewed pair cannot drift independently', () => {
  for (const changed of [
    workspace.replace('core@0.3.3', 'core@0.3.4'),
    workspace.replace('    vite: 0.3.3', '    vite: 0.3.4'),
    workspace.replace('vitest: 4.1.11', 'vitest: 4.2.0'),
    workspace.replace('  vitest: 4.1.11', ''),
  ]) {
    assert.throws(() => toolchainOutcome(manifest, changed, '24.19.0', pair));
  }
});

await test('Node and package-manager versions require exact compatible pins', () => {
  assert.throws(() => toolchainOutcome(manifest, workspace, '24.18.0', pair));
  assert.throws(() => toolchainOutcome(manifest, workspace, '25.0.0', pair));
  assert.throws(() =>
    toolchainOutcome({ ...manifest, packageManager: 'pnpm@latest' }, workspace, '24.19.0', pair),
  );
});

await test('Renovate config has no automatic merge path', () => {
  const config: unknown = JSON.parse(readFileSync('renovate.json5', 'utf8'));
  assert.equal(renovateOutcome(config).status, 'pass');
  for (const changed of [
    { ...object(config), automerge: true },
    { ...object(config), vulnerabilityAlerts: { automerge: true } },
    { ...object(config), minor: { automerge: true } },
  ]) {
    assert.throws(() => renovateOutcome(changed));
  }
});
