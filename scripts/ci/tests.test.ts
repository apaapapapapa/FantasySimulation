import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { testRepository } from '../harness/test-support/repository.ts';
import { bytesHash } from '../harness/load-contract.ts';
import { sharedTests, testIdentity } from './tests.ts';

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
