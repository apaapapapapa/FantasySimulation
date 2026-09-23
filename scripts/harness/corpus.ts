// Issue #9 (H5) step 1: fixed regression corpus identity, existing-test adapter and coverage.
// The report/coverage concepts follow Issue #9's description of HiFiScout scripts/harness/replay.ts
// at 36aaf69d3f7a61195af4e85a468514dfbb1ecc80; no HiFiScout code or catalog/D1 adapters are copied.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  canonicalJson,
  contentHash,
  IdSchema,
  RefSchema,
  type BattleResult,
  type RevisionRef,
} from '../../packages/domain/src/spatial/index.ts';
import {
  catalogManifest,
  implementation,
  prepareBattle,
  runBattle,
  sampleManifest,
  type PreparedBattle,
} from '../../packages/engine/src/spatial/index.ts';
import { readBoundedBytes, readBoundedJson } from './files.ts';
import { runCommand, type CommandResult } from './process.ts';
import { assessReport, evidenceUri, record, text } from './report.ts';
import type { Check, CheckStatus, Report } from './report.ts';
import { evidencePath, repositoryRoot, sourceIdentity } from './source.ts';

export const CORPUS_OUTPUT = '.generated/harness/corpus';
export const CORPUS_CHECKS = [
  'corpus:definition',
  'corpus:engine-identity',
  'corpus:identity',
  'corpus:repeat',
  'corpus:tests',
] as const;

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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
function fields(value: unknown, keys: readonly string[], where: string) {
  const object = record(value);
  if (Object.keys(object).sort().join() !== [...keys].sort().join())
    throw new Error(`${where}: expected exactly ${keys.join(', ')}`);
  return object;
}
function integer(value: unknown, max: number, where: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${where}: integer ${min}..${max} required`);
  return value;
}
function hash(value: unknown, where: string): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value))
    throw new Error(`${where}: sha256 hash required`);
  return value;
}
function word(value: unknown, where: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${where}: text of at most ${max} characters required`);
  return value;
}
function id(value: unknown, where: string): string {
  const parsed = IdSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${where}: invalid ID`);
  return parsed.data;
}
function reference(value: unknown, where: string): RevisionRef {
  const parsed = RefSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${where}: invalid revision reference`);
  return parsed.data;
}
function array(value: unknown, max: number, where: string): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`${where}: array of at most ${max} items required`);
  return value;
}
function unique(values: readonly string[], where: string) {
  if (new Set(values).size !== values.length) throw new Error(`${where}: duplicate values`);
}

function parseRecipe(value: unknown, where: string): Recipe {
  const kind = record(value).kind;
  if (kind === 'sample') {
    const recipe = fields(value, ['kind', 'maxSteps'], where);
    return { kind, maxSteps: integer(recipe.maxSteps, 6000, `${where}.maxSteps`, 1) };
  }
  if (kind !== 'catalog') throw new Error(`${where}: unsupported recipe kind`);
  const recipe = fields(value, ['kind', 'left', 'right', 'scenario', 'maxSteps', 'seed'], where);
  return {
    kind,
    left: id(recipe.left, `${where}.left`),
    right: id(recipe.right, `${where}.right`),
    scenario: id(recipe.scenario, `${where}.scenario`),
    maxSteps: integer(recipe.maxSteps, 6000, `${where}.maxSteps`, 1),
    seed: integer(recipe.seed, 0xffff_ffff, `${where}.seed`),
  };
}
function parseContract(value: unknown): Contract {
  const contract = fields(
    value,
    [
      'engineVersion',
      'rulesVersion',
      'manifestSchemaVersion',
      'eventSchemaVersion',
      'replaySchemaVersion',
      'prng',
      'seedDerivation',
      'physicsProfileHash',
      'wasmHash',
      'angleTableHash',
    ],
    'contract',
  );
  return {
    engineVersion: word(contract.engineVersion, 'contract.engineVersion'),
    rulesVersion: word(contract.rulesVersion, 'contract.rulesVersion'),
    manifestSchemaVersion: integer(contract.manifestSchemaVersion, 1000, 'contract', 1),
    eventSchemaVersion: integer(contract.eventSchemaVersion, 1000, 'contract', 1),
    replaySchemaVersion: integer(contract.replaySchemaVersion, 1000, 'contract', 1),
    prng: word(contract.prng, 'contract.prng'),
    seedDerivation: word(contract.seedDerivation, 'contract.seedDerivation'),
    physicsProfileHash: hash(contract.physicsProfileHash, 'contract.physicsProfileHash'),
    wasmHash: hash(contract.wasmHash, 'contract.wasmHash'),
    angleTableHash: hash(contract.angleTableHash, 'contract.angleTableHash'),
  };
}
function parseIdentity(value: unknown, where: string): InputIdentity {
  const identity = fields(
    value,
    ['inputHash', 'seed', 'scenario', 'ruleset', 'participants'],
    where,
  );
  const participants = array(identity.participants, 2, `${where}.participants`).map((item, i) => {
    const participant = fields(item, ['actorId', 'character'], `${where}.participants[${i}]`);
    return {
      actorId: id(participant.actorId, `${where}.participants[${i}].actorId`),
      character: reference(participant.character, `${where}.participants[${i}].character`),
    };
  });
  if (participants.length !== 2) throw new Error(`${where}: two participants required`);
  return {
    inputHash: hash(identity.inputHash, `${where}.inputHash`),
    seed: integer(identity.seed, 0xffff_ffff, `${where}.seed`),
    scenario: reference(identity.scenario, `${where}.scenario`),
    ruleset: reference(identity.ruleset, `${where}.ruleset`),
    participants,
  };
}
/** Strict, bounded corpus schema: unknown fields, dangling tests and unowned plans are rejected. */
export function parseCorpus(value: unknown): Corpus {
  const corpus = fields(
    value,
    ['schemaVersion', 'contract', 'tests', 'entries', 'categories'],
    'corpus',
  );
  if (corpus.schemaVersion !== 1) throw new Error('corpus: unsupported schemaVersion');
  const tests = new Map<string, TestRef>();
  for (const [key, item] of Object.entries(record(corpus.tests))) {
    const test = fields(item, ['file', 'name'], `tests.${key}`);
    const file = evidenceUri(test.file);
    // Paths become Vitest arguments: never let data look like an option.
    if (!/^(?:apps|packages|scripts)\/[\w./-]+\.test\.ts$/.test(file))
      throw new Error(`tests.${key}: a workspace .test.ts file is required`);
    tests.set(id(key, 'tests key'), { file, name: word(test.name, `tests.${key}.name`, 500) });
  }
  if (!tests.size || tests.size > 256) throw new Error('tests: 1..256 required tests expected');
  unique(
    [...tests.values()].map((test) => `${test.file}\n${test.name}`),
    'tests',
  );
  const known = (value: unknown, where: string) =>
    array(value, 64, where).map((key, i) => {
      const name = id(key, `${where}[${i}]`);
      if (!tests.has(name)) throw new Error(`${where}: unknown test ${name}`);
      return name;
    });
  const entries = array(corpus.entries, 64, 'entries').map((item, i) => {
    const entry = fields(item, ['id', 'purpose', 'recipe', 'oracles', 'identity'], `entries[${i}]`);
    return {
      id: id(entry.id, `entries[${i}].id`),
      purpose: word(entry.purpose, `entries[${i}].purpose`),
      recipe: parseRecipe(entry.recipe, `entries[${i}].recipe`),
      oracles: known(entry.oracles, `entries[${i}].oracles`),
      identity: parseIdentity(entry.identity, `entries[${i}].identity`),
    };
  });
  const categories = array(corpus.categories, 64, 'categories').map((item, i): Category => {
    const category = fields(item, ['id', 'title', 'state', 'owner', 'tests'], `categories[${i}]`);
    const where = `categories[${i}]`;
    const covered = known(category.tests, `${where}.tests`);
    if (category.state === 'implemented' && category.owner === null && covered.length)
      return {
        id: id(category.id, `${where}.id`),
        title: word(category.title, `${where}.title`),
        state: 'implemented',
        owner: null,
        tests: covered,
      };
    if (category.state === 'planned' && typeof category.owner === 'string' && !covered.length)
      return {
        id: id(category.id, `${where}.id`),
        title: word(category.title, `${where}.title`),
        state: 'planned',
        owner: word(category.owner, `${where}.owner`),
        tests: [],
      };
    throw new Error(`${where}: implemented needs tests and no owner; planned needs an owner only`);
  });
  if (!entries.length || !categories.some((category) => category.state === 'implemented'))
    throw new Error('corpus: fixed inputs and implemented coverage are required');
  unique(
    entries.map((entry) => entry.id),
    'entries',
  );
  unique(
    categories.map((category) => category.id),
    'categories',
  );
  const used = new Set(
    [...entries, ...categories].flatMap((item) => ('oracles' in item ? item.oracles : item.tests)),
  );
  const unused = [...tests.keys()].filter((key) => !used.has(key));
  if (unused.length) throw new Error(`tests: unreferenced ${unused.join(', ')}`);
  return { schemaVersion: 1, contract: parseContract(corpus.contract), tests, entries, categories };
}

export type RecipeBuilder = (recipe: Recipe) => Promise<unknown>;
export type BattleRunner = (manifest: unknown) => Promise<BattleResult>;
export const buildRecipe: RecipeBuilder = (recipe) =>
  recipe.kind === 'sample'
    ? sampleManifest(recipe.maxSteps)
    : catalogManifest(recipe.left, recipe.right, recipe.scenario, recipe.maxSteps, recipe.seed);
const engineBattle: BattleRunner = async (manifest) => (await runBattle(manifest)).result;

/** The input hash covers the normalized manifest except the running engine's source digest. */
export async function observedInput(prepared: PreparedBattle) {
  const { implementationDigest: _, ...semantic } = prepared.manifest;
  const contract: Contract = {
    engineVersion: prepared.manifest.engineVersion,
    rulesVersion: prepared.rules.rulesVersion,
    manifestSchemaVersion: prepared.manifest.schemaVersion,
    eventSchemaVersion: prepared.manifest.eventSchemaVersion,
    replaySchemaVersion: prepared.manifest.replaySchemaVersion,
    prng: prepared.manifest.prng,
    seedDerivation: prepared.manifest.seedDerivation,
    physicsProfileHash: prepared.manifest.physicsProfileHash,
    wasmHash: prepared.manifest.wasmHash,
    angleTableHash: prepared.manifest.angleTableHash,
  };
  const identity: InputIdentity = {
    inputHash: await contentHash(semantic),
    seed: prepared.manifest.seed,
    scenario: { ...prepared.manifest.scenario },
    ruleset: { ...prepared.manifest.ruleset },
    participants: prepared.manifest.participants.map((participant) => ({
      actorId: participant.actorId,
      character: { ...participant.character },
    })),
  };
  return { contract, identity };
}
function differences(expected: object, actual: object): string[] {
  const left = expected as Record<string, unknown>,
    right = actual as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => canonicalJson(left[key] ?? null) !== canonicalJson(right[key] ?? null))
    .sort();
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
/** Rebuild a fixed input, pin its identity, then execute it twice through the real engine. */
export async function observeEntry(
  entry: Entry,
  contract: Contract,
  build: RecipeBuilder = buildRecipe,
  battle: BattleRunner = engineBattle,
): Promise<EntryResult> {
  const result: EntryResult = {
    id: entry.id,
    simulationHash: null,
    contract: null,
    identity: null,
    contractDifferences: [],
    identityDifferences: [],
    runs: [],
    repeatDifferences: [],
    inputError: null,
    runError: null,
  };
  let manifest: unknown;
  try {
    manifest = await build(entry.recipe);
    const prepared = await prepareBattle(structuredClone(manifest));
    const observed = await observedInput(prepared);
    result.simulationHash = prepared.simulationHash;
    result.contract = observed.contract;
    result.identity = observed.identity;
    result.contractDifferences = differences(contract, observed.contract);
    result.identityDifferences = differences(entry.identity, observed.identity);
  } catch (error) {
    result.inputError = message(error);
    return result;
  }
  try {
    for (let run = 0; run < 2; run++) result.runs.push(await battle(structuredClone(manifest)));
    result.repeatDifferences = differences(result.runs[0]!, result.runs[1]!);
  } catch (error) {
    result.runError = message(error);
  }
  return result;
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
  } else if (runner?.exitCode !== 0 || runner.bounded) {
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

export interface CorpusOptions {
  run?: typeof runCommand;
  build?: RecipeBuilder;
  battle?: BattleRunner;
  env?: NodeJS.ProcessEnv;
}
/** Read-only corpus runner: existing checks/tests are executed, never rewritten or restamped. */
export async function collectCorpus(
  inputRoot: string,
  corpusPath: string,
  options: CorpusOptions = {},
) {
  const run = options.run ?? runCommand;
  const root = repositoryRoot(inputRoot);
  const info = sourceIdentity(root, options.env ?? process.env);
  const startedAt = new Date().toISOString();
  const path = evidenceUri(corpusPath);
  const directory = evidencePath(root, CORPUS_OUTPUT);
  // Remove the previous run first so an interrupted command can never leave stale results behind.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const output = (name: string) => join(directory, name);
  let corpus: Corpus | null = null,
    definitionError: string | null = null,
    corpusSha256: string | null = null;
  try {
    const bytes = readBoundedBytes(join(root, path), 1024 * 1024);
    corpusSha256 = createHash('sha256').update(bytes).digest('hex');
    corpus = parseCorpus(JSON.parse(bytes.toString('utf8')) as unknown);
  } catch (error) {
    definitionError = message(error);
  }
  const engineCheck = await run(process.execPath, ['scripts/engine-identity.ts'], root, {
    timeoutMs: 2 * 60 * 1000,
    maxBytes: 1024 * 1024,
  });
  writeFileSync(output('engine-check.log'), engineCheck.output);
  const tests: TestRun = { command: null, outcomes: null, failedFiles: 0, error: null };
  let testArgs: string[] = [];
  if (corpus) {
    const files = [...new Set([...corpus.tests.values()].map((test) => test.file))].sort();
    testArgs = [
      join(root, 'node_modules', 'vite-plus', 'bin', 'vp'),
      'test',
      'run',
      ...files,
      '--reporter=json',
      `--outputFile=${output('vitest.json')}`,
    ];
    tests.command = await run(process.execPath, testArgs, root, {
      timeoutMs: 10 * 60 * 1000,
      maxBytes: 4 * 1024 * 1024,
    });
    writeFileSync(output('tests.log'), tests.command.output);
    try {
      Object.assign(
        tests,
        vitestOutcomes(root, readBoundedJson(output('vitest.json'), 16 * 1024 * 1024)),
      );
    } catch (error) {
      tests.error = message(error);
    }
  }
  const entries: EntryResult[] = [];
  if (corpus)
    for (const entry of corpus.entries)
      entries.push(await observeEntry(entry, corpus.contract, options.build, options.battle));
  const checks = corpusChecks({
    sourceSha: info.sourceSha,
    corpusPath: path,
    corpus,
    definitionError,
    engineCheck,
    tests,
    entries,
  });
  writeFileSync(
    output('results.json'),
    JSON.stringify(
      {
        ...info,
        schemaVersion: 1,
        platform: process.platform,
        nodeVersion: process.version,
        corpus: { path, sha256: corpusSha256 },
        engine: implementation,
        commands: {
          engineCheck: {
            command: [process.execPath, 'scripts/engine-identity.ts'],
            exitCode: engineCheck.exitCode,
            bounded: engineCheck.bounded,
          },
          tests: tests.command && {
            command: [process.execPath, ...testArgs],
            exitCode: tests.command.exitCode,
            bounded: tests.command.bounded,
          },
        },
        tests: corpus
          ? [...corpus.tests.entries()].map(([key, test]) => ({
              key,
              ...test,
              status: testStatus(tests.outcomes, test),
            }))
          : [],
        entries,
      },
      null,
      2,
    ) + '\n',
  );
  const report: Report = {
    ...info,
    schemaVersion: 1,
    producer: 'corpus-runner',
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
  };
  const required = checks.filter((check) => check.required).map((check) => check.id);
  const assessed = assessReport(report, [...new Set([...CORPUS_CHECKS, ...required])]);
  writeFileSync(output('report.json'), JSON.stringify(assessed.report, null, 2) + '\n');
  return assessed;
}
