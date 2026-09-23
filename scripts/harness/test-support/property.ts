import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc, { type IAsyncProperty, type Parameters as PropertyParameters } from 'fast-check';
import { git } from '../source.ts';

export const PROPERTY_VERSION = 'bounded-properties-v1';
/** No per-case timeout: interrupted async predicates must finish cleanup before another case starts. */
export async function checkProperty<T extends [unknown, ...unknown[]]>(
  id: string,
  file: string,
  property: IAsyncProperty<T>,
  options: PropertyParameters<T> = {},
  battleContext: { manifestHash: string; battleSeed: number } | null = null,
) {
  assert.match(id, /^[a-z0-9-]+$/);
  const parameters = {
    seed: 20260923,
    numRuns: 24,
    maxSkipsPerRun: 1,
    interruptAfterTimeLimit: 30000,
    markInterruptAsFailure: true,
    ...options,
  };
  const replay = process.env.FANTASY_PROPERTY_ID === id;
  if (replay) {
    const seed = Number(process.env.FANTASY_PROPERTY_SEED);
    assert.ok(Number.isSafeInteger(seed), 'Replay needs an integer seed');
    parameters.seed = seed;
    parameters.path = process.env.FANTASY_PROPERTY_PATH ?? '';
  }
  const result = await fc.check(property, parameters);
  const sourceSha = git(process.cwd(), ['rev-parse', 'HEAD']);
  const receipt = {
    schemaVersion: 1,
    sourceSha,
    id,
    file,
    fastCheckVersion: fc.__version,
    generatorVersion: PROPERTY_VERSION,
    propertyVersion: PROPERTY_VERSION,
    seed: result.seed,
    path: result.counterexamplePath,
    numRuns: result.numRuns,
    numSkips: result.numSkips,
    numShrinks: result.numShrinks,
    failed: result.failed,
    interrupted: result.interrupted,
    shrinkComplete: !result.interrupted,
    minimizedInput: result.counterexample,
    error: result.errorInstance instanceof Error ? result.errorInstance.message : null,
    parameters,
    battleContext,
    contextReason: battleContext
      ? 'Prepared base manifest; generated overrides are in minimizedInput'
      : 'Unit or ownership-model property without a battle manifest',
    command: ['pnpm', 'exec', 'vp', 'test', 'run', file],
    commandKind: 'reproduction',
    launch: { executable: process.execPath, argv: process.argv, execArgv: process.execArgv },
    replay: { seed: result.seed, path: result.counterexamplePath, input: result.counterexample },
  };
  const directory = '.generated/harness/properties';
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), JSON.stringify(receipt, null, 2) + '\n');
  assert.equal(result.interrupted, false, `Property interrupted: ${id}`);
  assert.equal(result.failed, false, JSON.stringify(receipt));
  if (!replay) assert.equal(result.numRuns, parameters.numRuns, `Incomplete property: ${id}`);
  assert.equal(result.numSkips, 0, `Discarded input: ${id}`);
  return receipt;
}
