import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vite-plus/test';
import type { BattleResult } from '@fantasy/domain/spatial';
import { prepareBattle, runBattle } from '@fantasy/engine/spatial';
import { sampleManifest } from '@fantasy/samples';
import {
  collectCorpus,
  corpusChecks,
  observeCorpus,
  observedInput,
  observeEntry,
  parseCorpus,
  vitestOutcomes,
  type Contract,
  type CorpusObservation,
  type EntryResult,
  type InputIdentity,
} from './corpus.ts';
import { bindCorpus } from './corpus-checks.ts';
import { bytesHash } from './load-contract.ts';
import type { CommandResult } from './process.ts';
import { assessReport } from './report.ts';
import { testRepository } from './test-support/repository.ts';
import { TEST_SHARDS, testIdentity } from '../ci/tests.ts';

const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
const ref = (id: string) => ({ id, revision: 1, contentHash: digest('b') });
const tests = {
  golden: { file: 'packages/engine/src/spatial/a.test.ts', name: 'suite keeps a fixed digest' },
  order: { file: 'packages/engine/src/spatial/b.test.ts', name: 'ignores enumeration order' },
};
type TestKey = keyof typeof tests;
interface Draft {
  [key: string]: unknown;
  contract: Contract;
  tests: Record<string, { file: string; name: string }>;
  entries: {
    id: string;
    purpose: string;
    recipe: Record<string, unknown>;
    oracles: string[];
    identity: InputIdentity;
  }[];
  categories: { id: string; title: string; state: string; owner: string | null; tests: string[] }[];
}
/** Synthetic identities suffice for schema tests; runner tests pass the real engine values. */
function definition(pinned?: { contract: Contract; identity: InputIdentity }): Draft {
  return {
    schemaVersion: 1,
    contract: pinned?.contract ?? {
      engineVersion: 'spatial-v1.10',
      rulesVersion: 'spatial-v1.10',
      manifestSchemaVersion: 3,
      eventSchemaVersion: 1,
      replaySchemaVersion: 1,
      prng: 'xorshift32-v1',
      seedDerivation: 'actor-stream-v1',
      physicsProfileHash: digest('c'),
      wasmHash: digest('d'),
      angleTableHash: digest('e'),
    },
    tests: structuredClone(tests),
    entries: [
      {
        id: 'short-melee',
        purpose: 'short symmetric melee',
        recipe: { kind: 'sample', maxSteps: 20 },
        oracles: ['golden'],
        identity: pinned?.identity ?? {
          inputHash: digest('a'),
          seed: 42,
          scenario: ref('flat'),
          ruleset: ref('standard'),
          participants: [
            { actorId: 'left', character: ref('fighter') },
            { actorId: 'right', character: ref('fighter') },
          ],
        },
      },
    ],
    categories: [
      { id: 'fixed', title: 'fixed digests', state: 'implemented', owner: null, tests: ['golden'] },
      { id: 'order', title: 'enumeration', state: 'implemented', owner: null, tests: ['order'] },
      { id: 'cross-os', title: 'cross OS', state: 'planned', owner: '#9 PR 2', tests: [] },
    ],
  };
}
const realPinned = async () => observedInput(await prepareBattle(await sampleManifest(20)));
const battleResult = (): BattleResult => ({
  schemaVersion: 1,
  simulationHash: digest('1'),
  eventHash: digest('2'),
  trajectoryHash: digest('3'),
  tsStateHash: digest('4'),
  physicsStateHash: digest('5'),
  steps: 20,
  outcome: { kind: 'draw', reason: 'time-limit' },
  stats: { events: 1, logBytes: 10, casts: 0, candidates: 0, pathNodes: 0, peakProjectiles: 0 },
});
const command = (exitCode: number | null = 0): CommandResult => ({
  exitCode,
  signal: null,
  output: 'log\n',
  bounded: false,
});
/** Vitest JSON reporter shape; `missing` models a renamed or deleted required test. */
function vitestJson(root: string, statuses: Partial<Record<TestKey, string>> = {}) {
  return {
    testResults: Object.entries(tests).map(([key, test]) => {
      const status = statuses[key as TestKey] ?? 'passed';
      return {
        name: join(root, test.file),
        status: status === 'failed' ? 'failed' : 'passed',
        assertionResults: status === 'missing' ? [] : [{ fullName: test.name, status }],
      };
    }),
  };
}

describe('regression corpus definition', () => {
  it('accepts the committed corpus with owned plans and fully referenced tests', () => {
    const corpus = parseCorpus(
      JSON.parse(
        readFileSync(
          new URL('../../packages/engine/fixtures/spatial/corpus.json', import.meta.url),
          'utf8',
        ),
      ),
    );
    assert.ok(corpus.entries.length > 0);
    for (const category of corpus.categories)
      assert.equal(category.state === 'planned', category.owner !== null);
  });
  it.each([
    ['unknown fields', (c: Draft) => (c.extra = true), /expected exactly/],
    ['dangling tests', (c: Draft) => c.categories[0]!.tests.push('gone'), /unknown test/],
    ['unreferenced tests', (c: Draft) => (c.categories[1]!.tests = ['golden']), /unreferenced/],
    ['duplicate entries', (c: Draft) => c.entries.push(c.entries[0]!), /entries: duplicate/],
    ['unowned plans', (c: Draft) => (c.categories[2]!.owner = null), /planned needs an owner/],
    ['plans claiming tests', (c: Draft) => c.categories[2]!.tests.push('order'), /planned/],
    ['unsafe paths', (c: Draft) => (c.tests.golden!.file = '../a.test.ts'), /repository-relative/],
    ['non-test files', (c: Draft) => (c.tests.golden!.file = 'packages/a.ts'), /\.test\.ts/],
    ['unknown recipes', (c: Draft) => (c.entries[0]!.recipe = { kind: 'live' }), /unsupported/],
    ['one participant', (c: Draft) => c.entries[0]!.identity.participants.pop(), /two/],
  ])('rejects %s', (_name, mutate, expected) => {
    const corpus = definition();
    mutate(corpus);
    assert.throws(() => parseCorpus(corpus), expected);
  });
});

describe('fixed input identity and repeated execution', { timeout: 15000 }, () => {
  it('pins the real manifest identity and detects an injected determinism violation', async () => {
    const corpus = parseCorpus(definition(await realPinned()));
    const entry = corpus.entries[0]!;
    let calls = 0;
    const tampered = await observeEntry(entry, corpus.contract, undefined, async (manifest) => {
      const { result } = await runBattle(manifest);
      return calls++ ? { ...result, physicsStateHash: digest('0') } : result;
    });
    assert.deepEqual(tampered.identityDifferences, []);
    assert.deepEqual(tampered.contractDifferences, []);
    assert.deepEqual(tampered.repeatDifferences, ['physicsStateHash']);
    const stable = await observeEntry(entry, corpus.contract);
    assert.deepEqual(stable.repeatDifferences, []);
    assert.equal(stable.runs[0]!.simulationHash, stable.simulationHash);
  });
  it('reports changed inputs, contracts and unreproducible recipes without running them', async () => {
    const pinned = await realPinned();
    const corpus = parseCorpus(definition(pinned));
    const entry = { ...corpus.entries[0]!, identity: { ...pinned.identity, seed: 7 } };
    const contract = { ...corpus.contract, rulesVersion: 'spatial-v2' };
    const drift = await observeEntry(entry, contract, undefined, async () => battleResult());
    assert.deepEqual(drift.identityDifferences, ['seed']);
    assert.deepEqual(drift.contractDifferences, ['rulesVersion']);
    const missing = await observeEntry(entry, contract, async () => {
      throw new Error('Unknown catalog entry: removed');
    });
    assert.match(missing.inputError!, /removed/);
    assert.equal(missing.runs.length, 0);
  });
});

describe('existing test adapter and coverage checks', () => {
  const root = join('/', 'repo');
  function observation(
    change: (value: CorpusObservation) => void = () => {},
    statuses: Partial<Record<TestKey, string>> = {},
  ) {
    const corpus = parseCorpus(definition());
    const entry: EntryResult = {
      id: 'short-melee',
      simulationHash: digest('1'),
      contract: corpus.contract,
      identity: corpus.entries[0]!.identity,
      contractDifferences: [],
      identityDifferences: [],
      runs: [battleResult(), battleResult()],
      repeatDifferences: [],
      inputError: null,
      runError: null,
    };
    const value: CorpusObservation = {
      sourceSha: 'a'.repeat(40),
      corpusPath: 'packages/engine/fixtures/spatial/corpus.json',
      corpus,
      definitionError: null,
      engineCheck: command(),
      tests: {
        command: command(),
        ...vitestOutcomes(root, vitestJson(root, statuses)),
        error: null,
      },
      entries: [entry],
    };
    change(value);
    const checks = corpusChecks(value);
    const exitCode = assessReport(
      {
        schemaVersion: 1,
        producer: 'corpus-runner',
        sourceSha: value.sourceSha,
        candidateSha: value.sourceSha,
        baselineSha: null,
        testMergeSha: null,
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:00:01Z',
        checks,
      },
      checks.filter((check) => check.required).map((check) => check.id),
    ).exitCode;
    const status = (id: string) => checks.find((check) => check.id === id)?.status;
    return { exitCode, status, checks };
  }
  it('passes complete evidence and never counts planned coverage', () => {
    const result = observation();
    assert.equal(result.exitCode, 0);
    const planned = result.checks.find((check) => check.id === 'coverage:cross-os')!;
    assert.deepEqual([planned.required, planned.status], [false, 'unknown']);
  });
  it('never passes missing or duplicate fixed execution entries', () => {
    for (const duplicate of [false, true]) {
      const result = observation((value) => {
        value.entries = duplicate ? [value.entries[0]!, value.entries[0]!] : [];
      });
      assert.equal(result.status('corpus:identity'), 'unknown');
      assert.equal(result.status('corpus:repeat'), 'unknown');
      assert.equal(result.exitCode, 2);
    }
  });
  it.each([
    ['a failed required test', {}, { golden: 'failed' }, 'corpus:tests', 'fail', 1],
    ['a renamed required test', {}, { order: 'missing' }, 'coverage:order', 'unknown', 2],
    ['a skipped required test', {}, { golden: 'skipped' }, 'coverage:fixed', 'unknown', 2],
    ['missing Vitest output', { outcomes: null }, {}, 'corpus:tests', 'unknown', 2],
    ['a failed test file', { failedFiles: 1 }, {}, 'corpus:tests', 'fail', 1],
    ['an unsuccessful runner', { command: command(1) }, {}, 'corpus:tests', 'unknown', 2],
  ] as const)('classifies %s', (_name, testRun, statuses, id, status, exitCode) => {
    const result = observation((value) => Object.assign(value.tests, testRun), statuses);
    assert.deepEqual([result.status(id), result.exitCode], [status, exitCode]);
  });
  it.each([
    ['stale engine identity', { engineCheck: command(1) }, 'corpus:engine-identity', 'fail', 1],
    ['a determinism violation', { repeatDifferences: ['eventHash'] }, 'corpus:repeat', 'fail', 1],
    ['an interrupted run', { runs: [], runError: 'WASM failed' }, 'corpus:repeat', 'unknown', 2],
    ['a changed fixed input', { identityDifferences: ['inputHash'] }, 'corpus:identity', 'fail', 1],
    [
      'an invalid corpus',
      { corpus: null, definitionError: 'bad' },
      'corpus:identity',
      undefined,
      2,
    ],
  ] as const)('classifies %s', (_name, change, id, status, exitCode) => {
    const result = observation((value) => {
      if ('engineCheck' in change || 'corpus' in change) Object.assign(value, change);
      else Object.assign(value.entries[0]!, change);
    });
    assert.deepEqual([result.status(id), result.exitCode], [status, exitCode]);
  });
});

describe('corpus runner evidence', { timeout: 30000 }, () => {
  it('binds fresh evidence to the checkout and runs each existing command once', async () => {
    const repo = testRepository({ 'corpus.json': JSON.stringify(definition(await realPinned())) });
    try {
      const output = join(repo.root, '.generated/harness/corpus');
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, 'vitest.json'), '{"testResults":[]}');
      const commands: string[] = [];
      const result = await collectCorpus(repo.root, 'corpus.json', {
        env: {},
        battle: async () => battleResult(),
        run: async (_program, args) => {
          commands.push(args[0]!.endsWith('engine-identity.ts') ? 'engine' : args[1]!);
          const file = args.find((arg) => arg.startsWith('--outputFile='));
          // Vitest runs with the canonical root as cwd; Windows TEMP can be an 8.3 alias.
          const reported = vitestJson(realpathSync.native(repo.root));
          if (file) writeFileSync(file.slice(13), JSON.stringify(reported));
          return command();
        },
      });
      assert.deepEqual(commands, ['engine', 'test']);
      assert.equal(result.exitCode, 0);
      const sha = repo.git('rev-parse', 'HEAD').trim();
      for (const check of result.report.checks.filter((item) => item.status === 'pass'))
        assert.ok(check.evidence.every((item) => item.sourceSha === sha));
      const saved = JSON.parse(readFileSync(join(output, 'results.json'), 'utf8')) as {
        entries: EntryResult[];
      };
      assert.equal(saved.entries[0]!.runs.length, 2);
      assert.ok(existsSync(join(output, 'report.json')));
    } finally {
      repo.dispose();
    }
  });
  it('neither runs tests nor trusts stale results for an invalid definition', async () => {
    const repo = testRepository({ 'corpus.json': '{"schemaVersion":2}' });
    try {
      const output = join(repo.root, '.generated/harness/corpus');
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, 'vitest.json'), JSON.stringify(vitestJson(repo.root)));
      const result = await collectCorpus(repo.root, 'corpus.json', {
        env: {},
        run: async (_program, args) => {
          assert.ok(args[0]!.endsWith('engine-identity.ts'), 'Tests must not run');
          return command();
        },
      });
      assert.equal(result.exitCode, 2);
      assert.equal(existsSync(join(output, 'vitest.json')), false);
      assert.equal(
        result.report.checks.find((check) => check.id === 'corpus:tests')?.status,
        'unknown',
      );
    } finally {
      repo.dispose();
    }
  });
});

describe('parallel corpus observation bound by the aggregate', { timeout: 30000 }, () => {
  const run = { GITHUB_RUN_ID: '41', GITHUB_RUN_ATTEMPT: '2' };
  // Every shard must report at least one file: the two mapped tests plus unmapped fillers.
  const fillers = Array.from(
    { length: TEST_SHARDS - 2 },
    (_, index) => `packages/engine/src/spatial/filler-${index}.test.ts`,
  );
  async function observed(edit: (value: Draft) => void = () => {}) {
    const value = definition(await realPinned());
    edit(value);
    const repo = testRepository({
      'corpus.json': JSON.stringify(value),
      ...Object.fromEntries(
        [...Object.values(tests).map((test) => test.file), ...fillers].map((file) => [
          file,
          'export {};\n',
        ]),
      ),
    });
    const previous = { ...process.env };
    Object.assign(process.env, run);
    try {
      const commands: string[] = [];
      const observation = await observeCorpus(repo.root, 'corpus.json', {
        env: run,
        battle: async () => battleResult(),
        run: async (_program, args) => {
          commands.push(args[0]!);
          return command();
        },
      });
      return { repo, observation, commands, restore: () => (process.env = previous) };
    } catch (error) {
      process.env = previous;
      repo.dispose();
      throw error;
    }
  }
  function receipts(root: string, statuses: Partial<Record<TestKey, string>> = {}) {
    const mapped = vitestJson(root, statuses).testResults;
    const files = [
      ...mapped,
      ...fillers.map((file) => ({
        name: join(root, file),
        status: 'passed',
        assertionResults: [{ fullName: 'filler', status: 'passed' }],
      })),
    ];
    for (const [index, file] of files.entries()) {
      const directory = join(root, '.generated/harness/tests', String(index + 1));
      mkdirSync(directory, { recursive: true });
      const bytes = JSON.stringify({
        success: file.status === 'passed',
        numFailedTests: file.status === 'passed' ? 0 : 1,
        numFailedTestSuites: 0,
        testResults: [file],
      });
      writeFileSync(join(directory, 'vitest.json'), bytes);
      writeFileSync(
        join(directory, 'receipt.json'),
        JSON.stringify({
          identity: testIdentity(root),
          shard: index + 1,
          shards: TEST_SHARDS,
          exitCode: 0,
          bounded: false,
          digest: bytesHash(bytes),
        }),
      );
    }
  }
  it('observes without running tests, then binds shared receipts into the standalone format', async () => {
    const { repo, observation, commands, restore } = await observed();
    try {
      assert.deepEqual(commands, ['scripts/engine-identity.ts']);
      assert.equal(observation.exitCode, 0);
      assert.equal(observation.report.producer, 'corpus-observer');
      const output = join(repo.root, '.generated/harness/corpus');
      assert.equal(existsSync(join(output, 'report.json')), false);
      receipts(repo.root);
      const bound = bindCorpus(repo.root, 'corpus.json', TEST_SHARDS);
      assert.equal(bound.exitCode, 0);
      assert.equal(bound.report.producer, 'corpus-runner');
      const saved = JSON.parse(readFileSync(join(output, 'results.json'), 'utf8')) as {
        commands: { sharedTestShards: number; tests: unknown };
        entries: EntryResult[];
      };
      assert.equal(saved.commands.sharedTestShards, TEST_SHARDS);
      assert.equal(saved.commands.tests, null);
      assert.equal(saved.entries[0]!.runs.length, 2);
    } finally {
      restore();
      repo.dispose();
    }
  });
  it('fails the bound report for failed mapped tests and rejects stale observations', async () => {
    const { repo, restore } = await observed();
    try {
      receipts(repo.root, { golden: 'failed' });
      const failed = bindCorpus(repo.root, 'corpus.json', TEST_SHARDS);
      assert.equal(failed.exitCode, 2);
      assert.equal(
        failed.report.checks.find((check) => check.id === 'corpus:tests')?.status,
        'unknown',
      );
      receipts(repo.root);
      process.env.GITHUB_RUN_ATTEMPT = '3';
      assert.throws(() => bindCorpus(repo.root, 'corpus.json', TEST_SHARDS), /Stale/);
      process.env.GITHUB_RUN_ATTEMPT = '2';
      writeFileSync(join(repo.root, 'corpus.json'), '{}');
      assert.throws(() => bindCorpus(repo.root, 'corpus.json', TEST_SHARDS), /Stale/);
    } finally {
      restore();
      repo.dispose();
    }
  });
  it('fails the observation itself on engine drift before any binding', async () => {
    const { repo, observation, restore } = await observed(
      (value) => (value.entries[0]!.identity.seed = 7),
    );
    try {
      assert.equal(observation.exitCode, 1);
      assert.equal(
        observation.report.checks.find((check) => check.id === 'corpus:identity')?.status,
        'fail',
      );
    } finally {
      restore();
      repo.dispose();
    }
  });
});
