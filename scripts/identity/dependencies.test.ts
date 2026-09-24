import { afterEach, expect, it } from 'vite-plus/test';
import { runtimeDependencies, lockData, workspaceTarget } from './dependencies.ts';
import { identityProject, ENGINE, INTEGRITY } from './test-support/project.ts';

const projects: ReturnType<typeof identityProject>[] = [];
function fixture() {
  const f = identityProject();
  projects.push(f);
  return f;
}
afterEach(() => {
  for (const f of projects.splice(0)) f.dispose();
});

it('follows recursive snapshots and peer identities, retains cycles and ignores unrelated packages', () => {
  const f = fixture();
  f.write(`${ENGINE}/package.json`, JSON.stringify({ dependencies: { library: '1.0.0' } }));
  const lock = {
    importers: {
      [ENGINE]: { dependencies: { library: { specifier: '1.0.0', version: '1.0.0(peer@2.0.0)' } } },
    },
    packages: {
      'library@1.0.0': { resolution: { integrity: INTEGRITY }, peerDependencies: { peer: '*' } },
      'peer@2.0.0': { resolution: { integrity: INTEGRITY } },
      'unrelated@99.0.0': {},
    },
    snapshots: {
      'library@1.0.0(peer@2.0.0)': { dependencies: { peer: '2.0.0' } },
      'peer@2.0.0': { dependencies: { library: '1.0.0(peer@2.0.0)' } },
    },
  };
  for (const [name, version] of [
    ['library', '1.0.0'],
    ['peer', '2.0.0'],
  ])
    f.write(`node_modules/${name}/package.json`, JSON.stringify({ name, version }));
  const edges = [{ importer: ENGINE, name: 'library' }];
  const result = runtimeDependencies(f.root, lock, edges);
  expect(result).toEqual({
    roots: [[ENGINE, 'library', 'library@1.0.0(peer@2.0.0)']],
    packages: [
      {
        id: 'library@1.0.0(peer@2.0.0)',
        integrity: INTEGRITY,
        dependencies: [['peer', 'peer@2.0.0']],
      },
      {
        id: 'peer@2.0.0',
        integrity: INTEGRITY,
        dependencies: [['library', 'library@1.0.0(peer@2.0.0)']],
      },
    ],
  });
  expect(runtimeDependencies(f.root, lock, [...edges, ...edges])).toEqual(result);
  lock.packages['peer@2.0.0'].resolution.integrity =
    `sha512-${Buffer.alloc(64, 3).toString('base64')}`;
  expect(runtimeDependencies(f.root, lock, edges)).not.toEqual(result);
  lock.snapshots['library@1.0.0(peer@2.0.0)'].dependencies = {} as { peer: string };
  expect(() => runtimeDependencies(f.root, lock, edges)).toThrow(/Missing resolved runtime peer/);
});
it('rejects stale importer pins, missing snapshots and omitted runtime dependencies', () => {
  const f = fixture(),
    lock = lockData(f.root),
    edges = [{ importer: ENGINE, name: '@dimforge/rapier3d-compat' }];
  f.write(`${ENGINE}/package.json`, f.read(`${ENGINE}/package.json`).replace('0.20.0', '0.21.0'));
  expect(() => runtimeDependencies(f.root, lock, edges)).toThrow(/Unfrozen/);
  f.write(`${ENGINE}/package.json`, f.read(`${ENGINE}/package.json`).replace('0.21.0', '0.20.0'));
  const snapshot = lock.snapshots['@dimforge/rapier3d-compat@0.20.0'];
  delete lock.snapshots['@dimforge/rapier3d-compat@0.20.0'];
  expect(() => runtimeDependencies(f.root, lock, edges)).toThrow();
  lock.snapshots['@dimforge/rapier3d-compat@0.20.0'] = snapshot;
  f.write(
    'node_modules/@dimforge/rapier3d-compat/package.json',
    JSON.stringify({
      name: '@dimforge/rapier3d-compat',
      version: '0.20.0',
      dependencies: { missing: '1.0.0' },
    }),
  );
  expect(() => runtimeDependencies(f.root, lock, edges)).toThrow(/Missing runtime dependency edge/);
});
it('validates concrete workspace exports and refuses conditional, missing or escaping targets', () => {
  const f = fixture(),
    lock = lockData(f.root);
  expect(workspaceTarget(f.root, lock, ENGINE, '@fantasy/domain/spatial/execution')).toBe(
    'packages/domain/src/spatial/execution.ts',
  );
  for (const target of [
    { import: './src/spatial/execution.ts' },
    './missing.ts',
    '../engine/src/spatial/execution.ts',
  ]) {
    f.write(
      'packages/domain/package.json',
      JSON.stringify({
        name: '@fantasy/domain',
        type: 'module',
        exports: { './spatial/execution': target },
      }),
    );
    expect(() =>
      workspaceTarget(f.root, lock, ENGINE, '@fantasy/domain/spatial/execution'),
    ).toThrow();
  }
});
