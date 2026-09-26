import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { testRepository } from '../harness/test-support/repository.ts';
import { bytesHash } from '../harness/load-contract.ts';
import { sharedTests, testIdentity, TEST_SHARDS } from './tests.ts';
import { heaviestFirst, shardFiles, testFiles, TEST_WEIGHTS } from './test-plan.ts';
import { WeightedSequencer } from './test-sequencer.ts';

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
  it('keeps other heavy files out of the real-Worker corpus shard', () => {
    const corpus = 'apps/api/src/jobs/worker-corpus.test.ts';
    const shard = shardFiles(testFiles(process.cwd()), TEST_SHARDS).find((files) =>
      files.includes(corpus),
    );
    const others = (shard ?? [])
      .filter((file) => file !== corpus)
      .map((file) => TEST_WEIGHTS[file] ?? 1);
    expect(others.length).toBeGreaterThan(0);
    expect(Math.max(...others)).toBeLessThan(5);
    expect(others.reduce((sum, value) => sum + value, 0)).toBeLessThan(TEST_WEIGHTS[corpus]!);
  });
  it('moves only the heaviest known file to the front and keeps the given order otherwise', () => {
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts'];
    const order = (weights: Record<string, number>) =>
      heaviestFirst(files, (file) => file, weights);
    expect(order({ 'b.test.ts': 5, 'd.test.ts': 9, 'e.test.ts': 5 })).toEqual([
      'd.test.ts',
      'a.test.ts',
      'b.test.ts',
      'c.test.ts',
      'e.test.ts',
    ]);
    expect(order({ 'b.test.ts': 5, 'e.test.ts': 5 })).toEqual([
      'b.test.ts',
      'a.test.ts',
      'c.test.ts',
      'd.test.ts',
      'e.test.ts',
    ]);
    expect(order({ 'c.test.ts': 1 })).toEqual(files);
    expect(order({})).toEqual(files);
  });
  it('starts the small but heaviest file first and leaves the rest in Vitest order', async () => {
    const root = process.cwd();
    const [heavy, next] = Object.entries(TEST_WEIGHTS)
      .sort(([, a], [, b]) => b - a)
      .map(([file]) => file);
    const sizes = new Map([
      ['large.test.ts', 3000],
      ['medium.test.ts', 2000],
      [heavy!, 1],
      [next!, 1],
    ]);
    const project = { name: '', config: { isolate: true, sequence: { groupOrder: 0 } } };
    const sequencer = new WeightedSequencer({
      config: { root },
      cache: {
        getFileTestResults: () => undefined,
        getFileStats: (key: string) => ({ size: sizes.get(key.slice(1)) }),
      },
    } as never);
    const specs = [...sizes.keys()].map((file) => ({ project, moduleId: join(root, file) }));
    const sorted = await sequencer.sort(specs as never);
    expect(sorted.map((spec) => relative(root, spec.moduleId))).toEqual([
      heavy,
      'large.test.ts',
      'medium.test.ts',
      next,
    ]);
    const { default: config } = await import('../../vite.config.ts');
    expect(config.test?.sequence?.sequencer).toBe(WeightedSequencer);
  });
});
