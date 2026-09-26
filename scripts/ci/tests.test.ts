import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { testRepository } from '../harness/test-support/repository.ts';
import { bytesHash } from '../harness/load-contract.ts';
import { sharedTests, testIdentity, TEST_SHARDS } from './tests.ts';
import { shardFiles, testFiles, TEST_WEIGHTS } from './test-plan.ts';

describe('sharing executed test results', () => {
  it('rejects stale source/run, missing coverage, tampering and skipped assertions', () => {
    const repo = testRepository({ 'scripts/example.test.ts': 'export {};\n' });
    try {
      const directory = join(repo.root, '.generated/harness/tests/1');
      mkdirSync(directory, { recursive: true });
      const file = {
        name: join(repo.root, 'scripts/example.test.ts'),
        status: 'passed',
        assertionResults: [{ fullName: 'real executed assertion', status: 'passed' }],
      };
      const result = {
        success: true,
        numFailedTests: 0,
        numFailedTestSuites: 0,
        testResults: [file],
      };
      const save = (value: unknown = result, edits: Record<string, unknown> = {}) => {
        const bytes = JSON.stringify(value);
        writeFileSync(join(directory, 'vitest.json'), bytes);
        writeFileSync(
          join(directory, 'receipt.json'),
          JSON.stringify({
            identity: testIdentity(repo.root),
            shard: 1,
            shards: 1,
            exitCode: 0,
            bounded: false,
            digest: bytesHash(bytes),
            ...edits,
          }),
        );
      };
      save();
      expect(sharedTests(repo.root, 1).testResults).toHaveLength(1);
      for (const edits of [
        { digest: 'wrong' },
        { bounded: true },
        { exitCode: 1 },
        { shard: 2 },
        { shards: 3 },
        { identity: { ...testIdentity(repo.root), runAttempt: '999' } },
      ]) {
        save(result, edits);
        expect(() => sharedTests(repo.root, 1)).toThrow(Error);
      }
      for (const testResults of [
        [],
        [file, file],
        [{ ...file, name: join(repo.root, 'scripts/other.test.ts') }],
        [
          {
            ...file,
            assertionResults: [{ fullName: 'real executed assertion', status: 'pending' }],
          },
        ],
      ]) {
        save({ ...result, testResults });
        expect(() => sharedTests(repo.root, 1)).toThrow(Error);
      }
      save();
      writeFileSync(join(repo.root, 'scripts/example.test.ts'), 'throw Error("changed");\n');
      expect(() => sharedTests(repo.root, 1)).toThrow(/Stale/);
      expect(() => sharedTests(repo.root, 3)).toThrow(Error);
      expect(() => sharedTests(repo.root, 0)).toThrow(Error);
    } finally {
      repo.dispose();
    }
  });
});
describe('duration-balanced test shards', () => {
  it('assigns every inventory file exactly once and spreads the heaviest files', () => {
    const files = testFiles(process.cwd());
    const shards = shardFiles(files, TEST_SHARDS);
    expect(shards).toHaveLength(TEST_SHARDS);
    expect(shards.flat().sort()).toEqual(files);
    expect(shards.every((shard) => shard.length > 0)).toBe(true);
    expect(shardFiles([...files].reverse(), TEST_SHARDS)).toEqual(shards);
    const heaviest = Object.entries(TEST_WEIGHTS)
      .sort(([, a], [, b]) => b - a)
      .slice(0, TEST_SHARDS)
      .map(([file]) => file);
    for (const shard of shards)
      expect(shard.filter((file) => heaviest.includes(file)).length).toBeLessThanOrEqual(1);
  });
  it('keeps listed weights on existing test files', () => {
    const files = new Set(testFiles(process.cwd()));
    for (const file of Object.keys(TEST_WEIGHTS)) expect(files.has(file)).toBe(true);
  });
});
