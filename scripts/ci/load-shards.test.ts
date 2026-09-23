import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { testRepository } from '../harness/test-support/repository.ts';
import { loadFixture, loadReceipts } from '../harness/test-support/load.ts';
import { bytesHash, fixtureHash, loadShardCases } from '../harness/load-contract.ts';
import { readPairedShards } from './load-artifacts.ts';
import { assessReport } from '../harness/report.ts';

it('requires every case, sample, runner pair, source and current attempt across load shards', () => {
  const repo = testRepository();
  const write = (path: string, value: unknown) => {
    mkdirSync(join(repo.root, path, '..'), { recursive: true });
    writeFileSync(join(repo.root, path), JSON.stringify(value));
  };
  try {
    const { after: sample, profile, info } = loadFixture();
    profile.limits = Object.fromEntries(
      ['a', 'b', 'c'].map((id) => [id, { ...profile.limits.battle! }]),
    );
    const corpus = { contract: { fixed: true }, entries: ['a', 'b', 'c'].map((id) => ({ id })) };
    write('.github/harness/load-profile.json', profile);
    write('packages/engine/fixtures/spatial/corpus.json', corpus);
    write('scripts/harness/load-capture.ts', 'fixed test driver');
    for (const [key, path] of [
      ['driverHash', 'scripts/harness/load-capture.ts'],
      ['profileHash', '.github/harness/load-profile.json'],
      ['corpusHash', 'packages/engine/fixtures/spatial/corpus.json'],
    ] as const)
      sample[key] = bytesHash(readFileSync(join(repo.root, path)));
    sample.fixtureHash = fixtureHash(corpus);
    for (let shard = 1; shard <= 3; shard++) {
      const directory = `evidence/harness-load-${shard}`;
      const ids = loadShardCases(profile, shard);
      const after = {
        ...structuredClone(sample),
        runnerId: `physical-runner-${shard}`,
        samples: sample.samples.map((row) => ({ ...structuredClone(row), id: ids[0]! })),
      };
      const before = { ...structuredClone(after), sourceSha: info.baselineSha! };
      write(`${directory}/results.json`, { before, after, previousProfile: profile });
      write(`${directory}/report.json`, loadReceipts(info)['load-pair']);
      write(`${directory}/baseline-corpus.json`, corpus);
      write(`${directory}/baseline-profile.json`, profile);
      write(`${directory}/performance.json`, { observation: 'synthetic timings' });
      write(`${directory}/commands.json`, {
        runnerId: after.runnerId,
        shard,
        runId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        errors: [],
        commands: [{ exitCode: 0, bounded: false, output: 'capture.log' }],
      });
      write(`${directory}/capture.log`, 'successful fixture command');
      for (const [side, value] of [
        ['before', before],
        ['after', after],
      ] as const) {
        write(`${directory}/regression-${side}.json`, {
          sourceSha: value.sourceSha,
          driverSha: info.sourceSha,
          status: 'passed',
        });
        for (let trial = 0; trial < 5; trial++)
          write(`${directory}/${trial}-${side}.json`, {
            ...value,
            samples: [value.samples[trial]],
          });
      }
    }
    const collect = () => readPairedShards(repo.root, join(repo.root, 'evidence'), info, null);
    expect(
      assessReport(collect(), ['load:comparison', 'load:budget:after', 'load:shard:3']).exitCode,
    ).toBe(0);
    for (const path of [
      'harness-load-2/report.json',
      'harness-load-3/4-before.json',
      'harness-load-1/capture.log',
    ]) {
      const file = join(repo.root, 'evidence', path),
        bytes = readFileSync(file);
      rmSync(file);
      expect(collect).toThrow(Error);
      writeFileSync(file, bytes);
    }
    const commandPath = 'evidence/harness-load-1/commands.json';
    const original = JSON.parse(readFileSync(join(repo.root, commandPath), 'utf8')) as Record<
      string,
      unknown
    >;
    for (const changes of [
      { shard: 2 },
      { runAttempt: '999' },
      { runnerId: 'other runner' },
      { commands: [{ exitCode: 1, bounded: false }] },
    ]) {
      write(commandPath, { ...original, ...changes });
      expect(collect).toThrow(Error);
    }
    write(commandPath, original);
    const trialPath = 'evidence/harness-load-2/0-after.json';
    const trial = JSON.parse(readFileSync(join(repo.root, trialPath), 'utf8')) as Record<
      string,
      unknown
    >;
    write(trialPath, { ...trial, sourceSha: info.baselineSha });
    expect(collect).toThrow(Error);
  } finally {
    repo.dispose();
  }
});
