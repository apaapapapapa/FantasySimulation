// Issue #9 (H5) step 1: fixed regression corpus identity, existing-test adapter and coverage.
// The report/coverage concepts follow Issue #9's description of HiFiScout scripts/harness/replay.ts
// at 36aaf69d3f7a61195af4e85a468514dfbb1ecc80; no HiFiScout code or catalog/D1 adapters are copied.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJson,
  contentHash,
  IdSchema,
  RefSchema,
  type BattleResult,
  type RevisionRef,
} from '@fantasy/domain/spatial';
import {
  implementation,
  prepareBattle,
  runBattle,
  type PreparedBattle,
} from '@fantasy/engine/spatial';
import { catalogManifest, sampleManifest } from '@fantasy/samples';
import {
  array,
  CORPUS_OUTPUT,
  CORPUS_TEST_CAPACITY,
  observedExitCode,
  OBSERVATION_FILE,
  saveCorpusEvidence,
  serializeCorpus,
  vitestOutcomes,
  type Category,
  type Contract,
  type Corpus,
  type CorpusObservationRecord,
  type Entry,
  type EntryResult,
  type InputIdentity,
  type Recipe,
  type TestRef,
  type TestRun,
} from './corpus-checks.ts';
import { readBoundedBytes, readBoundedJson } from './files.ts';
import { runCommand } from './process.ts';
import { evidenceUri, record } from './report.ts';
import { evidencePath, repositoryRoot, sourceIdentity } from './source.ts';

// Existing callers, including the regression probe loaded from older checkouts, keep this module.
export {
  CORPUS_CHECKS,
  CORPUS_OUTPUT,
  corpusChecks,
  vitestOutcomes,
  type Contract,
  type CorpusObservation,
  type EntryResult,
  type InputIdentity,
  type Recipe,
} from './corpus-checks.ts';

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
  if (!tests.size || tests.size > CORPUS_TEST_CAPACITY)
    throw new Error(`tests: 1..${CORPUS_TEST_CAPACITY} required tests expected`);
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

export interface CorpusOptions {
  run?: typeof runCommand;
  build?: RecipeBuilder;
  battle?: BattleRunner;
  env?: NodeJS.ProcessEnv;
}
const ENGINE_CHECK = ['scripts/engine-identity.ts'];
/** Source identity, definition and engine identity of a fresh corpus run; no test outcome yet. */
async function observeDefinition(inputRoot: string, corpusPath: string, options: CorpusOptions) {
  const root = repositoryRoot(inputRoot);
  const env = options.env ?? process.env;
  const info = sourceIdentity(root, env);
  const startedAt = new Date().toISOString();
  const path = evidenceUri(corpusPath);
  const directory = evidencePath(root, CORPUS_OUTPUT);
  // Remove the previous run first so an interrupted command can never leave stale results behind.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
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
  const engineCheck = await (options.run ?? runCommand)(process.execPath, ENGINE_CHECK, root, {
    timeoutMs: 2 * 60 * 1000,
    maxBytes: 1024 * 1024,
  });
  writeFileSync(join(directory, 'engine-check.log'), engineCheck.output);
  return {
    root,
    env,
    info,
    startedAt,
    path,
    directory,
    corpus,
    definitionError,
    corpusSha256,
    engineCheck,
  };
}
async function observeEntries(corpus: Corpus | null, options: CorpusOptions) {
  const entries: EntryResult[] = [];
  if (corpus)
    for (const entry of corpus.entries)
      entries.push(await observeEntry(entry, corpus.contract, options.build, options.battle));
  return entries;
}
const commandRecord = (args: string[], result: { exitCode: number | null; bounded: boolean }) => ({
  command: [process.execPath, ...args],
  exitCode: result.exitCode,
  bounded: result.bounded,
});
/** Read-only corpus runner: existing checks/tests are executed, never rewritten or restamped. */
export async function collectCorpus(
  inputRoot: string,
  corpusPath: string,
  options: CorpusOptions = {},
) {
  const run = options.run ?? runCommand;
  const { root, info, startedAt, path, directory, corpus, definitionError, ...observed } =
    await observeDefinition(inputRoot, corpusPath, options);
  const { corpusSha256, engineCheck } = observed;
  const output = (name: string) => join(directory, name);
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
  const entries = await observeEntries(corpus, options);
  return saveCorpusEvidence(
    directory,
    {
      info,
      startedAt,
      platform: process.platform,
      nodeVersion: process.version,
      corpusSha256,
      engine: implementation,
      engineCheck: commandRecord(ENGINE_CHECK, engineCheck),
      sharedTestShards: null,
      tests: tests.command && commandRecord(testArgs, tests.command),
    },
    {
      sourceSha: info.sourceSha,
      corpusPath: path,
      corpus,
      definitionError,
      engineCheck,
      tests,
      entries,
    },
  );
}
/**
 * CI observation in parallel with the test shards. The aggregate binds it to their receipts with
 * bindCorpus, producing the same results/report as standalone collection without rerunning tests.
 */
export async function observeCorpus(
  inputRoot: string,
  corpusPath: string,
  options: CorpusOptions = {},
) {
  const { env, info, startedAt, path, directory, corpus, definitionError, ...observed } =
    await observeDefinition(inputRoot, corpusPath, options);
  const { corpusSha256, engineCheck } = observed;
  const entries = await observeEntries(corpus, options);
  const saved: CorpusObservationRecord & { schemaVersion: 1; producer: 'corpus-observer' } = {
    schemaVersion: 1,
    producer: 'corpus-observer',
    info,
    runId: env.GITHUB_RUN_ID ?? null,
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
    startedAt,
    platform: process.platform,
    nodeVersion: process.version,
    corpusPath: path,
    corpusSha256,
    engine: implementation,
    engineCheck: commandRecord(ENGINE_CHECK, engineCheck),
    sharedTestShards: null,
    tests: null,
    definition: serializeCorpus(corpus),
    definitionError,
    entries,
  };
  writeFileSync(join(directory, OBSERVATION_FILE), JSON.stringify(saved, null, 2) + '\n');
  return observedExitCode(
    {
      sourceSha: info.sourceSha,
      corpusPath: path,
      corpus,
      definitionError,
      engineCheck,
      tests: { command: null, outcomes: null, failedFiles: 0, error: 'Bound by the aggregate' },
      entries,
    },
    info,
  );
}
