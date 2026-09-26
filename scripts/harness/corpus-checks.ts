// Engine-free corpus evidence: result/report format, check classification and the CI binding of
// a parallel corpus observation to the shared test receipts of the same tree and run attempt.
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BattleResult, RevisionRef } from '@fantasy/domain/spatial';
import { readBoundedJson } from './files.ts';
import type { CommandResult } from './process.ts';
import { assessReport, identity, record, text } from './report.ts';
import type { Check, CheckStatus, Identity, Report } from './report.ts';
import { evidencePath, git } from './source.ts';
import { sharedTests } from '../ci/tests.ts';

export const CORPUS_OUTPUT = '.generated/harness/corpus';
export const CORPUS_TEST_CAPACITY = 512;
export const CORPUS_CHECKS = [
  'corpus:definition',
  'corpus:engine-identity',
  'corpus:identity',
  'corpus:repeat',
  'corpus:tests',
] as const;
/** Checks that need no test outcome; the parallel CI observation must pass them before binding. */
export const OBSERVED_CHECKS = CORPUS_CHECKS.filter((id) => id !== 'corpus:tests');

export type Recipe =
  | { kind: 'sample'; maxSteps: number }
  | {
      kind: 'catalog';
      left: string;
      right: string;
      scenario: string;
      maxSteps: number;
      seed: number;
    };
/** Everything a corpus result depends on except the implementation digest of the running engine. */
export interface Contract {
  engineVersion: string;
  rulesVersion: string;
  manifestSchemaVersion: number;
  eventSchemaVersion: number;
  replaySchemaVersion: number;
  prng: string;
  seedDerivation: string;
  physicsProfileHash: string;
  wasmHash: string;
  angleTableHash: string;
}
export interface InputIdentity {
  inputHash: string;
  seed: number;
  scenario: RevisionRef;
  ruleset: RevisionRef;
  participants: { actorId: string; character: RevisionRef }[];
}
export interface TestRef {
  file: string;
  name: string;
}
export interface Entry {
  id: string;
  purpose: string;
  recipe: Recipe;
  oracles: string[];
  identity: InputIdentity;
}
export interface Category {
  id: string;
  title: string;
  state: 'implemented' | 'planned';
  owner: string | null;
  tests: string[];
}
export interface Corpus {
  schemaVersion: 1;
  contract: Contract;
  tests: ReadonlyMap<string, TestRef>;
  entries: Entry[];
  categories: Category[];
}

export interface EntryResult {
  id: string;
  simulationHash: string | null;
  contract: Contract | null;
  identity: InputIdentity | null;
  contractDifferences: string[];
  identityDifferences: string[];
  runs: BattleResult[];
  repeatDifferences: string[];
  inputError: string | null;
  runError: string | null;
}

export function array(value: unknown, max: number, where: string): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`${where}: array of at most ${max} items required`);
  return value;
}

const testKey = (test: TestRef) => `${test.file}\n${test.name}`;
/** Map Vitest JSON reporter output to repository-relative test IDs. */
export function vitestOutcomes(root: string, value: unknown) {
  const outcomes = new Map<string, string[]>();
  let failedFiles = 0;
  for (const item of array(record(value).testResults, 10_000, 'testResults')) {
    const file = record(item);
    const path = relative(root, resolve(text(file.name))).replaceAll('\\', '/');
    if (file.status === 'failed') failedFiles++;
    for (const assertion of array(file.assertionResults, 100_000, `${path} assertions`)) {
      const test = record(assertion);
      const key = testKey({ file: path, name: text(test.fullName) });
      outcomes.set(key, [...(outcomes.get(key) ?? []), text(test.status)]);
    }
  }
  return { outcomes, failedFiles };
}
function testStatus(outcomes: ReadonlyMap<string, string[]> | null, test: TestRef): CheckStatus {
  const seen = outcomes?.get(testKey(test)) ?? [];
  if (seen.includes('failed')) return 'fail';
  return seen.length && seen.every((status) => status === 'passed') ? 'pass' : 'unknown';
}
function combined(statuses: readonly CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail';
  return statuses.length && statuses.every((status) => status === 'pass') ? 'pass' : 'unknown';
}
export interface TestRun {
  shared?: boolean;
  command: CommandResult | null;
  outcomes: ReadonlyMap<string, string[]> | null;
  failedFiles: number;
  error: string | null;
}
export interface CorpusObservation {
  sourceSha: string;
  corpusPath: string;
  corpus: Corpus | null;
  definitionError: string | null;
  engineCheck: CommandResult;
  tests: TestRun;
  entries: EntryResult[];
}
const bounded = (value: string) => (value.length > 2000 ? `${value.slice(0, 1997)}...` : value);
/** Missing, skipped or unexecuted evidence stays unknown; planned coverage is never reported as passed. */
export function corpusChecks(observation: CorpusObservation): Check[] {
  const { corpus, corpusPath, engineCheck, tests, entries } = observation;
  const evidence = (...paths: string[]) =>
    paths.map((path) => ({
      uri: path === corpusPath ? path : `${CORPUS_OUTPUT}/${path}`,
      sourceSha: observation.sourceSha,
    }));
  const checks: Check[] = [
    {
      id: 'corpus:definition',
      required: true,
      status: corpus ? 'pass' : 'unknown',
      reason: corpus
        ? `${corpus.entries.length} fixed inputs, ${corpus.tests.size} required tests and ${corpus.categories.length} coverage categories`
        : bounded(`Invalid corpus definition: ${observation.definitionError ?? 'unavailable'}`),
      evidence: evidence(corpusPath),
    },
    {
      id: 'corpus:engine-identity',
      required: true,
      status: engineCheck.exitCode === 0 && !engineCheck.bounded ? 'pass' : 'fail',
      reason: `Existing engine:check (node scripts/engine-identity.ts) exit=${engineCheck.exitCode}; bounded=${engineCheck.bounded}`,
      evidence: evidence('engine-check.log'),
    },
  ];
  if (!corpus) return checks;
  const expectedIds = corpus.entries.map((entry) => entry.id).sort();
  const actualIds = entries.map((entry) => entry.id).sort();
  const completeEntries = JSON.stringify(expectedIds) === JSON.stringify(actualIds);
  const drift = entries.filter(
    (entry) =>
      entry.inputError || entry.contractDifferences.length || entry.identityDifferences.length,
  );
  checks.push({
    id: 'corpus:identity',
    required: true,
    status: drift.length ? 'fail' : completeEntries ? 'pass' : 'unknown',
    reason: drift.length
      ? bounded(
          `Fixed input or engine contract differs from the reviewed corpus: ${drift
            .map(
              (entry) =>
                `${entry.id} (${entry.inputError ?? [...entry.contractDifferences.map((key) => `contract.${key}`), ...entry.identityDifferences].join(', ')})`,
            )
            .join('; ')}`,
        )
      : completeEntries
        ? `${entries.length} fixed inputs match their pinned manifest identity and engine contract`
        : 'Missing, duplicate or extra fixed inputs',
    evidence: evidence(corpusPath, 'results.json'),
  });
  const unstable = entries.filter((entry) => entry.repeatDifferences.length);
  const incomplete = entries.filter((entry) => entry.runs.length !== 2);
  checks.push({
    id: 'corpus:repeat',
    required: true,
    status: unstable.length ? 'fail' : incomplete.length || !completeEntries ? 'unknown' : 'pass',
    reason: unstable.length
      ? bounded(
          `Determinism violation: ${unstable.map((entry) => `${entry.id} (${entry.repeatDifferences.join(', ')})`).join('; ')}`,
        )
      : incomplete.length
        ? bounded(
            `Repeated execution incomplete: ${incomplete.map((entry) => `${entry.id} (${entry.inputError ?? entry.runError ?? 'not run'})`).join('; ')}`,
          )
        : `${entries.length} fixed inputs reproduced identical result, event, trajectory, TS state and physics digests twice`,
    evidence: evidence('results.json'),
  });
  const required = [...corpus.tests.entries()].map(([key, test]) => ({
    key,
    status: testStatus(tests.outcomes, test),
  }));
  const missing = required.filter((test) => test.status === 'unknown').map((test) => test.key);
  const failed = required.filter((test) => test.status === 'fail').map((test) => test.key);
  const runner = tests.command;
  let status: CheckStatus = 'pass',
    reason = `${required.length} required existing tests passed`;
  if (!tests.outcomes) {
    status = 'unknown';
    reason = `No Vitest result evidence: ${tests.error ?? 'not run'}`;
  } else if (failed.length || tests.failedFiles) {
    status = 'fail';
    reason = `Failed required tests: ${failed.join(', ') || 'none'}; unsuccessful test files: ${tests.failedFiles}`;
  } else if (missing.length) {
    status = 'unknown';
    reason = `Required tests missing, renamed or not passed: ${missing.join(', ')}`;
  } else if (!tests.shared && (runner?.exitCode !== 0 || runner.bounded)) {
    status = 'unknown';
    reason = `Vitest exit=${runner?.exitCode}; bounded=${runner?.bounded}`;
  }
  checks.push({
    id: 'corpus:tests',
    required: true,
    status,
    reason: bounded(reason),
    evidence: evidence('vitest.json', 'tests.log'),
  });
  for (const category of corpus.categories) {
    if (category.state === 'planned') {
      checks.push({
        id: `coverage:${category.id}`,
        required: false,
        status: 'unknown',
        reason: bounded(`Planned by ${category.owner}: ${category.title}. Not counted as covered.`),
        evidence: evidence(corpusPath),
      });
      continue;
    }
    const statuses = category.tests.map((key) =>
      testStatus(tests.outcomes, corpus.tests.get(key)!),
    );
    checks.push({
      id: `coverage:${category.id}`,
      required: true,
      status: combined(statuses),
      reason: bounded(
        `${category.title}: ${statuses.filter((value) => value === 'pass').length}/${statuses.length} mapped existing tests passed`,
      ),
      evidence: evidence(corpusPath, 'vitest.json'),
    });
  }
  return checks;
}

export interface CorpusCommand {
  command: string[];
  exitCode: number | null;
  bounded: boolean;
}
/** Everything results.json and report.json record besides the classified observation. */
export interface CorpusRecord {
  info: Identity;
  startedAt: string;
  platform: string;
  nodeVersion: string;
  corpusSha256: string | null;
  engine: unknown;
  engineCheck: CorpusCommand;
  sharedTestShards: number | null;
  tests: CorpusCommand | null;
}
/** The single writer of corpus results/report for standalone collection and CI binding. */
export function saveCorpusEvidence(
  directory: string,
  saved: CorpusRecord,
  observation: CorpusObservation,
) {
  const { corpus, tests } = observation;
  const checks = corpusChecks(observation);
  writeFileSync(
    join(directory, 'results.json'),
    JSON.stringify(
      {
        ...saved.info,
        schemaVersion: 1,
        platform: saved.platform,
        nodeVersion: saved.nodeVersion,
        corpus: { path: observation.corpusPath, sha256: saved.corpusSha256 },
        engine: saved.engine,
        commands: {
          sharedTestShards: saved.sharedTestShards,
          engineCheck: saved.engineCheck,
          tests: saved.tests,
        },
        tests: corpus
          ? [...corpus.tests.entries()].map(([key, test]) => ({
              key,
              ...test,
              status: testStatus(tests.outcomes, test),
            }))
          : [],
        entries: observation.entries,
      },
      null,
      2,
    ) + '\n',
  );
  const report: Report = {
    ...saved.info,
    schemaVersion: 1,
    producer: 'corpus-runner',
    startedAt: saved.startedAt,
    finishedAt: new Date().toISOString(),
    checks,
  };
  const required = checks.filter((check) => check.required).map((check) => check.id);
  const assessed = assessReport(report, [...new Set([...CORPUS_CHECKS, ...required])]);
  writeFileSync(join(directory, 'report.json'), JSON.stringify(assessed.report, null, 2) + '\n');
  return assessed;
}

export const OBSERVATION_FILE = 'observation.json';
/** Parallel CI observation: everything except test outcomes, bound to one source and run attempt. */
export interface CorpusObservationRecord extends CorpusRecord {
  runId: string | null;
  runAttempt: string | null;
  corpusPath: string;
  definition: unknown;
  definitionError: string | null;
  entries: EntryResult[];
}
export function serializeCorpus(corpus: Corpus | null) {
  return corpus && { ...corpus, tests: [...corpus.tests.entries()] };
}
function restoreCorpus(value: unknown): Corpus | null {
  if (value === null) return null;
  const corpus = record(value);
  const tests = new Map(
    array(corpus.tests, CORPUS_TEST_CAPACITY, 'observed tests').map((item) => {
      const [key, test] = array(item, 2, 'observed test');
      const ref = record(test);
      return [text(key), { file: text(ref.file), name: text(ref.name) }] as const;
    }),
  );
  return { ...(corpus as unknown as Corpus), tests };
}
/**
 * Complete a parallel observation with this tree's shared test receipts. The observed definition
 * was schema-validated on the same corpus bytes; its digest, source and run attempt must match.
 */
export function bindCorpus(root: string, corpusPath: string, testShards: number) {
  const directory = evidencePath(root, CORPUS_OUTPUT);
  for (const file of ['results.json', 'report.json', 'vitest.json', 'tests.log'])
    rmSync(join(directory, file), { force: true });
  const observed = record(readBoundedJson(join(directory, OBSERVATION_FILE), 32 * 1024 * 1024));
  const info = identity(observed.info);
  const bytes = readFileSync(join(root, corpusPath));
  const corpusSha256 = createHash('sha256').update(bytes).digest('hex');
  if (
    observed.schemaVersion !== 1 ||
    observed.producer !== 'corpus-observer' ||
    info.sourceSha !== git(root, ['rev-parse', 'HEAD']) ||
    observed.runId !== (process.env.GITHUB_RUN_ID ?? null) ||
    observed.runAttempt !== (process.env.GITHUB_RUN_ATTEMPT ?? null) ||
    observed.corpusPath !== corpusPath ||
    observed.corpusSha256 !== corpusSha256
  )
    throw new Error('Stale or foreign corpus observation');
  const corpus = restoreCorpus(observed.definition);
  const engineCheck = record(observed.engineCheck) as unknown as CorpusCommand;
  const tests: TestRun = { command: null, outcomes: null, failedFiles: 0, error: null };
  if (corpus) {
    try {
      const result = sharedTests(root, testShards);
      writeFileSync(join(directory, 'vitest.json'), JSON.stringify(result) + '\n');
      writeFileSync(
        join(directory, 'tests.log'),
        `Validated current-tree/current-run test receipts (${testShards} shards); no tests re-executed.\n`,
      );
      Object.assign(tests, vitestOutcomes(root, result), { shared: true });
    } catch (error) {
      tests.error = error instanceof Error ? error.message : String(error);
    }
  }
  const observation: CorpusObservation = {
    sourceSha: info.sourceSha,
    corpusPath,
    corpus,
    definitionError: observed.definitionError === null ? null : text(observed.definitionError),
    engineCheck: { ...engineCheck, signal: null, output: '' },
    tests,
    entries: array(observed.entries, 64, 'observed entries') as EntryResult[],
  };
  return saveCorpusEvidence(
    directory,
    {
      info,
      startedAt: text(observed.startedAt),
      platform: text(observed.platform),
      nodeVersion: text(observed.nodeVersion),
      corpusSha256,
      engine: observed.engine,
      engineCheck,
      sharedTestShards: tests.shared ? testShards : null,
      tests: null,
    },
    observation,
  );
}
/** Exit status of the observation alone: every check that does not need a test outcome. */
export function observedExitCode(observation: CorpusObservation, info: Identity) {
  const checks = corpusChecks(observation).filter((check) =>
    OBSERVED_CHECKS.some((id) => id === check.id),
  );
  const at = new Date().toISOString();
  return assessReport(
    {
      ...info,
      schemaVersion: 1,
      producer: 'corpus-observer',
      startedAt: at,
      finishedAt: at,
      checks,
    },
    [...OBSERVED_CHECKS],
  );
}
