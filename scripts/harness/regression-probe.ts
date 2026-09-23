import assert, { AssertionError } from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { git } from './source.ts';
import { bytesHash } from './load-contract.ts';
import type * as CorpusModule from './corpus.ts';

export async function probe(root: string, expected: string) {
  const driverRoot = fileURLToPath(new URL('../../', import.meta.url));
  const result = {
    id: 'missing-corpus-entries',
    sourceSha: expected,
    driverSha: git(driverRoot, ['rev-parse', 'HEAD']),
    driverHash: bytesHash(readFileSync(fileURLToPath(import.meta.url))),
    status: 'setup-error',
    assertion: 'Missing corpus entries must not pass identity or repetition',
    message: '',
  };
  try {
    if (git(root, ['rev-parse', 'HEAD']) !== expected || git(root, ['status', '--porcelain']))
      throw new Error('Wrong or dirty source');
    const target = (await import(
      pathToFileURL(join(root, 'scripts/harness/corpus.ts')).href
    )) as typeof CorpusModule;
    const corpus = target.parseCorpus(
      JSON.parse(readFileSync(join(root, 'packages/engine/fixtures/spatial/corpus.json'), 'utf8')),
    );
    const checks = target.corpusChecks({
      sourceSha: expected,
      corpusPath: 'packages/engine/fixtures/spatial/corpus.json',
      corpus,
      definitionError: null,
      engineCheck: { exitCode: 0, signal: null, bounded: false, output: '' },
      tests: { command: null, outcomes: null, failedFiles: 0, error: null },
      entries: [],
    });
    try {
      for (const id of ['corpus:identity', 'corpus:repeat'])
        assert.equal(
          checks.find((c) => c.id === id)?.status,
          'unknown',
          `${id}: zero completed fixtures cannot pass`,
        );
      result.status = 'passed';
    } catch (error) {
      if (!(error instanceof AssertionError)) throw error;
      result.status = 'assertion-failed';
      result.message = error.message;
    }
  } catch (error) {
    result.message = error instanceof Error ? error.message : String(error);
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, expected, output] = process.argv.slice(2);
  if (!root || !expected || !output) throw new Error('Missing regression arguments');
  const result = await probe(root, expected);
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status === 'passed' ? 0 : result.status === 'assertion-failed' ? 1 : 2;
}
