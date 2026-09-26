import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executionClosure, OUTPUT } from './closure.ts';
import { hash, sourceText } from './files.ts';
import { lockData, runtimeDependencies, runtimePackage } from './dependencies.ts';

export function engineIdentity(root: string) {
  const node = sourceText(root, '.node-version');
  if (node.trim() !== process.versions.node)
    throw Error('Executing Node differs from identity pin');
  const lock = lockData(root),
    closure = executionClosure(root, lock);
  const dependencies = runtimeDependencies(root, lock, closure.imports);
  const rapier = runtimePackage(root, 'packages/engine', '@dimforge/rapier3d-compat');
  const wasm = hash(readFileSync(join(rapier, 'dist/rapier_wasm3d_bg.wasm')));
  const binding = hash(readFileSync(join(rapier, 'dist/rapier.mjs')));
  const tablePath = 'packages/engine/src/spatial/sine-table.json';
  const profilePath = 'packages/engine/src/spatial/profile.json';
  if (
    ![tablePath, profilePath].every((path) => closure.sources.some(([source]) => source === path))
  )
    throw Error('Physics profile/table missing from execution closure');
  const table = hash(sourceText(root, tablePath));
  const payload = {
    algorithm: 'source-closure-v2',
    sources: [...closure.sources, ['.node-version', node]].sort(([a], [b]) =>
      a! < b! ? -1 : a! > b! ? 1 : 0,
    ),
    dependencies,
    assets: { wasm, binding, table },
  };
  return {
    payload,
    implementation: { digest: hash(JSON.stringify(payload)), wasm, binding, table },
  };
}
export function verifyIdentity(
  root: string,
  implementation: ReturnType<typeof engineIdentity>['implementation'],
) {
  const expected = `${JSON.stringify(implementation, null, 2)}\n`;
  if (sourceText(root, OUTPUT) !== expected)
    throw Error(
      'Stale engine identity; review the input diff and version policy before explicitly stamping. ' +
        `Computed descriptor (hashes only): ${JSON.stringify(implementation)}`,
    );
}
