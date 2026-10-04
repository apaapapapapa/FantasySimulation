import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { readBoundedBytes } from '../harness/files.ts';
import { command, digest, object, requireCondition } from './common.ts';

export const BRACES_PATCH_REASON = 'VERIFIED_BRACES_RECURSION_PATCH';
const patchHash = 'bfdb0c171556074c2785f98d0a7355209223df8e29dbc2ff489240c16a47da97';
const patchPath = 'patches/braces@3.0.3.patch';
const regressionPath = 'scripts/security/braces.test.ts';
const regressionHash = 'a7149f469af64413a433a524be8e0b8ecd52714a2e078df316323de67de2f45a';
// Owner approved on 2026-10-04. Exact runtime backport from upstream PR #72;
// changed code, dependency paths or tests require a new explicit policy review.
const installedHashes = {
  'package.json': '56f08b888a4f30dc7cf8a7dbb36ffe92b737912ba36abe9d069d32167c957ac7',
  'index.js': '332ea07c7b006361aad12aa994ca75dc1db8e8382b884909e2f38f10b85c88a4',
  'lib/compile.js': 'b651f7715e6db8942ce61d3394357b4d81c8ece88240aa31a458ea1165edd195',
  'lib/constants.js': 'f9fb688959232eee3e6ad7906a5b0e3234815db49ee857ef86983d65b917dc7c',
  'lib/expand.js': '7ea3e14c2b2b256ef244fd3d83b8fcaa20aa2232b4e6d768c3bb6ab567f66cf5',
  'lib/parse.js': '72aabaadaa555cdfbd07fbd7c7f743373e4dc8eec04a97550cc57bbeec30eb6c',
  'lib/stringify.js': '49dc2d8bafa74f34715a18a845bcb82ce66caaf3bab4cf117998e06b1f9a50a9',
  'lib/utils.js': 'b5a7596aa67730412b3c029ef09e84e6b67b8e445cffd35d1d295549c89066c7',
};
const paths = [
  '.>@semantic-release/commit-analyzer>micromatch>braces',
  '.>@semantic-release/commit-analyzer>semantic-release>micromatch>braces',
  '.>@semantic-release/github>semantic-release>@semantic-release/commit-analyzer>micromatch>braces',
  '.>@semantic-release/github>semantic-release>micromatch>braces',
  '.>@semantic-release/release-notes-generator>semantic-release>@semantic-release/commit-analyzer>micromatch>braces',
  '.>@semantic-release/release-notes-generator>semantic-release>micromatch>braces',
  '.>semantic-release>@semantic-release/commit-analyzer>micromatch>braces',
  '.>semantic-release>micromatch>braces',
];

export function recognizedBracesAdvisory(value: unknown): boolean {
  const advisory = object(value);
  if (
    advisory.github_advisory_id !== 'GHSA-vfj7-8cjw-p6xm' ||
    advisory.module_name !== 'braces' ||
    advisory.severity !== 'high' ||
    advisory.vulnerable_versions !== '<=3.0.3' ||
    advisory.cwe !== 'CWE-674' ||
    advisory.title !==
      'braces vulnerable to stack-exhaustion denial of service through deeply nested patterns' ||
    advisory.patched_versions !== null ||
    advisory.patched_versions_unpublished !== true ||
    !Array.isArray(advisory.findings) ||
    advisory.findings.length !== 1
  )
    return false;
  const finding = object(advisory.findings[0]);
  const findingPaths = finding.paths;
  return (
    finding.version === '3.0.3' &&
    finding.dev === true &&
    finding.optional === false &&
    finding.bundled === false &&
    Array.isArray(findingPaths) &&
    findingPaths.length === paths.length &&
    new Set(findingPaths).size === paths.length &&
    paths.every((path) => findingPaths.includes(path))
  );
}

function read(root: string, path: string): string {
  return readBoundedBytes(join(root, path)).toString('utf8');
}

function checkLock(value: unknown): void {
  const lock = object(value);
  requireCondition(
    object(lock.patchedDependencies)['braces@3.0.3'] === patchHash,
    'BRACES_PATCH_LOCK_HASH',
  );
  const packages = Object.keys(object(lock.packages)).filter((key) => key.startsWith('braces@'));
  const snapshots = Object.keys(object(lock.snapshots)).filter((key) => key.startsWith('braces@'));
  requireCondition(
    packages.length === 1 &&
      packages[0] === 'braces@3.0.3' &&
      snapshots.length === 1 &&
      snapshots[0] === `braces@3.0.3(patch_hash=${patchHash})`,
    'BRACES_UNREVIEWED_LOCK_ENTRY',
  );
}

export function verifyInstalledBraces(root = process.cwd()): void {
  root = resolve(root);
  const config = object(load(read(root, 'pnpm-workspace.yaml')));
  requireCondition(
    object(config.patchedDependencies)['braces@3.0.3'] === patchPath,
    'BRACES_PATCH_CONFIG',
  );
  requireCondition(digest(read(root, patchPath)) === patchHash, 'BRACES_PATCH_BYTES');
  requireCondition(
    digest(read(root, regressionPath)) === regressionHash,
    'BRACES_REGRESSION_BYTES',
  );
  checkLock(load(read(root, 'pnpm-lock.yaml')));
  checkLock(load(read(root, 'node_modules/.pnpm/lock.yaml')));
  // Resolve each reported route as Node does. An orphan in the pnpm store is not
  // an installed dependency; every reachable copy on these routes is checked.
  const directories = new Set<string>();
  for (const path of paths) {
    let entry = join(root, 'package.json');
    for (const name of path.split('>').slice(1)) entry = createRequire(entry).resolve(name);
    directories.add(dirname(entry));
  }
  for (const directory of directories) {
    for (const [file, hash] of Object.entries(installedHashes)) {
      requireCondition(digest(read(directory, file)) === hash, 'BRACES_INSTALLED_BYTES');
    }
  }
}

type Execution = Pick<
  ReturnType<typeof command>,
  'error' | 'signal' | 'status' | 'stdout' | 'stderr'
>;
export function verifyBracesRegression(result: Execution): void {
  requireCondition(
    !result.error && !result.signal && result.status === 0 && result.stderr.trim() === '',
    'BRACES_REGRESSION_EXECUTION',
  );
  for (const [label, count] of [
    ['tests', 7],
    ['pass', 7],
    ['fail', 0],
    ['cancelled', 0],
    ['skipped', 0],
    ['todo', 0],
  ]) {
    requireCondition(
      result.stdout.split('\n').filter((line) => line === `# ${label} ${count}`).length === 1,
      'BRACES_REGRESSION_INCOMPLETE',
    );
  }
}

export function verifyBracesPatch(): void {
  verifyInstalledBraces();
  verifyBracesRegression(
    command(process.execPath, ['--test', '--test-reporter=tap', regressionPath]),
  );
  verifyInstalledBraces();
}
