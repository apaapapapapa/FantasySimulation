import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Identity } from '../report.ts';

export function corpusEvidence(info: Identity) {
  const bytes = readFileSync(
    new URL('../../../packages/engine/fixtures/spatial/corpus.json', import.meta.url),
  );
  const definition = JSON.parse(bytes.toString('utf8')) as {
    contract: unknown;
    entries: { id: string; identity: unknown }[];
  };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const digest = `sha256:${'a'.repeat(64)}`;
  const source = {
    sourceSha: info.sourceSha,
    candidateSha: info.sourceSha,
    baselineSha: null,
    testMergeSha: null,
  };
  const result = {
    schemaVersion: 1,
    simulationHash: digest,
    eventHash: digest,
    trajectoryHash: digest,
    tsStateHash: digest,
    physicsStateHash: digest,
    steps: 1,
    outcome: { kind: 'draw', reason: 'time-limit' },
    stats: { events: 1, logBytes: 100, casts: 1, candidates: 0, pathNodes: 0, peakProjectiles: 0 },
  };
  const bundle = (platform: string) => ({
    results: {
      ...source,
      schemaVersion: 1,
      platform,
      nodeVersion: process.version,
      engine: { digest, wasm: digest, binding: digest, table: digest },
      corpus: { sha256 },
      entries: definition.entries.map((entry) => ({
        ...entry,
        contract: definition.contract,
        simulationHash: digest,
        contractDifferences: [],
        identityDifferences: [],
        repeatDifferences: [],
        inputError: null,
        runError: null,
        runs: [structuredClone(result), structuredClone(result)],
      })),
    },
    report: {
      ...source,
      schemaVersion: 1,
      producer: 'corpus-runner',
      startedAt: '2026-09-22T00:00:00Z',
      finishedAt: '2026-09-22T00:00:01Z',
      checks: ['definition', 'engine-identity', 'identity', 'repeat', 'tests'].map((id) => ({
        id: `corpus:${id}`,
        required: true,
        status: 'pass',
        reason: 'Synthetic comparator fixture',
        evidence: [{ uri: '.generated/harness/corpus/results.json', sourceSha: info.sourceSha }],
      })),
    },
  });
  return { definition, sha256, artifacts: { linux: bundle('linux'), win32: bundle('win32') } };
}
