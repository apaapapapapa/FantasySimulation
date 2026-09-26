import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { git } from '../harness/source.ts';
import { runCommand } from '../harness/process.ts';
import { readBoundedJson } from '../harness/files.ts';
import { record } from '../harness/report.ts';
import { testFiles } from './test-plan.ts';

export const TEST_SHARDS = 6;
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function testIdentity(root: string) {
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
  return {
    sourceSha: git(root, ['rev-parse', 'HEAD']),
    changes: digest(
      git(root, ['diff', '--binary', 'HEAD', '--']) +
        JSON.stringify(untracked.map((path) => [path, digest(readFileSync(join(root, path)))])),
    ),
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  };
}
function resultFiles(root: string, value: unknown) {
  const results = record(value);
  if (
    results.success !== true ||
    results.numFailedTests !== 0 ||
    results.numFailedTestSuites !== 0 ||
    !Array.isArray(results.testResults) ||
    !results.testResults.length
  )
    throw new Error('Test results are missing or unsuccessful');
  return results.testResults.map((entry: unknown) => {
    const file = record(entry);
    if (
      file.status !== 'passed' ||
      typeof file.name !== 'string' ||
      !Array.isArray(file.assertionResults) ||
      !file.assertionResults.length ||
      file.assertionResults.some((test: unknown) => record(test).status !== 'passed')
    )
      throw new Error('Incomplete, skipped or failed test file');
    return relative(root, resolve(file.name)).replaceAll('\\', '/');
  });
}
/** Only the current tree and run may share executed tests; this is never a cross-run success cache. */
export function sharedTests(root: string, shards: number) {
  if (![1, TEST_SHARDS].includes(shards)) throw new Error('Invalid shared test shard count');
  const expectedIdentity = testIdentity(root),
    seen: string[] = [],
    results: unknown[] = [];
  for (let shard = 1; shard <= shards; shard++) {
    const directory = join(root, '.generated/harness/tests', String(shard));
    const receipt = record(readBoundedJson(join(directory, 'receipt.json')));
    const bytes = readFileSync(join(directory, 'vitest.json'));
    if (
      !isDeepStrictEqual(receipt.identity, expectedIdentity) ||
      receipt.shard !== shard ||
      receipt.shards !== shards ||
      receipt.exitCode !== 0 ||
      receipt.bounded !== false ||
      receipt.digest !== digest(bytes)
    )
      throw new Error('Stale, incomplete or mismatched test receipt');
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    seen.push(...resultFiles(root, value));
    results.push(...(record(value).testResults as unknown[]));
  }
  if (!isDeepStrictEqual(seen.sort(), testFiles(root)))
    throw new Error('Missing, extra or duplicated test files');
  return { success: true, testResults: results };
}
export async function runTests(root: string, shard: number, shards: number) {
  if (!Number.isInteger(shard) || ![1, TEST_SHARDS].includes(shards) || shard < 1 || shard > shards)
    throw new Error('Invalid test shard');
  const directory = join(root, '.generated/harness/tests', String(shard));
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const identity = testIdentity(root);
  const output = join(directory, 'vitest.json');
  const args = [
    'test',
    'run',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${output}`,
    ...(shards > 1 ? [`--shard=${shard}/${shards}`] : []),
  ];
  const result = await runCommand('vp', args, root);
  writeFileSync(join(directory, 'tests.log'), result.output);
  process.stdout.write(result.output);
  const stable = isDeepStrictEqual(identity, testIdentity(root));
  const receipt = {
    identity,
    shard,
    shards,
    exitCode: result.exitCode,
    bounded: result.bounded,
    digest: result.exitCode === 0 && stable ? digest(readFileSync(output)) : null,
  };
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  if (result.exitCode !== 0 || result.bounded || !stable)
    throw new Error('Test execution failed or source changed');
  resultFiles(root, readBoundedJson(output, 32 * 1024 * 1024));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runTests(process.cwd(), Number(process.argv[2] ?? 1), Number(process.argv[3] ?? 1));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Test evidence failed');
    process.exitCode = 2;
  }
}
