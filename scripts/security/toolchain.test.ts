import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renovateOutcome, toolchainOutcome } from './toolchain.ts';
import { array, object } from './common.ts';

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

function renovateConfig(): Record<string, unknown> {
  return object(JSON.parse(readFileSync('renovate.json', 'utf8')) as unknown);
}

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
  const config = renovateConfig();
  assert.equal(renovateOutcome(config).status, 'pass');
  for (const changed of [
    { ...config, automerge: true },
    { ...config, platformAutomerge: true },
    { ...config, vulnerabilityAlerts: { automerge: true } },
    { ...config, lockFileMaintenance: { automerge: true } },
    { ...config, packageRules: [{ matchPackageNames: ['*'], automerge: true }] },
    { ...config, major: { automerge: true } },
    { ...config, minor: { automerge: true } },
    { ...config, patch: { platformAutomerge: true } },
  ]) {
    assert.throws(() => renovateOutcome(changed), /AUTOMERGE/);
  }
});

await test('automatic proposals stay bounded without pre-approval or weekly scheduling', () => {
  const config = renovateConfig();
  assert.equal(renovateOutcome(config).status, 'pass');
  assert.equal(config.dependencyDashboard, true);
  assert.equal(config.dependencyDashboardApproval, false);
  assert.deepEqual(config.schedule, ['at any time']);
  assert.equal(config.prHourlyLimit, 2);
  assert.equal(config.prConcurrentLimit, 3);
  assert.deepEqual(object(config.lockFileMaintenance).schedule, ['* 0-3 * * 1']);
  const groups = array(config.packageRules).map(object);
  assert.deepEqual(
    groups.filter((rule) => rule.groupName).map((rule) => rule.groupName),
    ['Vite+ and bundled test toolchain', 'Node and pnpm toolchain', 'Physics engine and WASM'],
  );
  assert.throws(
    () => renovateOutcome({ ...config, dependencyDashboard: false }),
    /DEPENDENCY_DASHBOARD_REQUIRED/,
  );
  assert.throws(
    () => renovateOutcome({ ...config, schedule: ['before 8am on monday'] }),
    /NORMAL_UPDATE_SCHEDULE_MUST_BE_UNRESTRICTED/,
  );
  assert.throws(
    () => renovateOutcome({ ...config, dependencyDashboardApproval: true }),
    /PR_CREATION_APPROVAL_MUST_BE_DISABLED/,
  );
});

await test('package and nested overrides cannot restore PR creation approval', () => {
  const config = renovateConfig();
  for (const changed of [
    { ...config, minor: { dependencyDashboardApproval: true } },
    {
      ...config,
      lockFileMaintenance: {
        ...object(config.lockFileMaintenance),
        dependencyDashboardApproval: true,
      },
    },
    {
      ...config,
      vulnerabilityAlerts: {
        ...object(config.vulnerabilityAlerts),
        dependencyDashboardApproval: true,
      },
    },
    {
      ...config,
      packageRules: [
        ...array(config.packageRules),
        { matchPackageNames: ['*'], automerge: false, dependencyDashboardApproval: true },
      ],
    },
  ]) {
    assert.throws(() => renovateOutcome(changed), /NESTED_PR_CREATION_APPROVAL_FORBIDDEN/);
  }
});
