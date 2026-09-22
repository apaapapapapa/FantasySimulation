import { isDeepStrictEqual } from 'node:util';
import { assessReport, identity, record, type Check, type Identity } from './report.ts';

export const CROSS_OS_CHECK = 'corpus:cross-os';
const digest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

/** Compare receipts from one CI run against the checked-out definition, never just each other. */
export function compareCorpus(
  info: Identity,
  definition: unknown,
  corpusSha256: string,
  artifacts: Record<string, unknown>,
): Check {
  const check: Check = {
    id: CROSS_OS_CHECK,
    required: true,
    status: 'unknown',
    reason: 'Missing or invalid corpus evidence',
    evidence: [],
  };
  try {
    const corpus = record(definition);
    if (!Array.isArray(corpus.entries) || !corpus.entries.length) throw new Error('Empty corpus');
    const expected = corpus.entries.map(record);
    const expectedIds = expected.map((e) => e.id).sort();
    // Source verification deliberately filters CI credentials/event environment from subprocesses.
    const childIdentity = {
      sourceSha: info.sourceSha,
      candidateSha: info.sourceSha,
      baselineSha: null,
      testMergeSha: null,
    };
    const results: unknown[][] = [];
    for (const platform of ['linux', 'win32']) {
      const bundle = record(artifacts[platform]);
      const raw = record(bundle.results);
      const report = assessReport(bundle.report, [
        'corpus:definition',
        'corpus:engine-identity',
        'corpus:identity',
        'corpus:repeat',
        'corpus:tests',
      ]);
      if (report.exitCode !== 0 || !isDeepStrictEqual(identity(report.report), childIdentity))
        throw new Error(`${platform}: unsuccessful or stale corpus report`);
      if (
        raw.schemaVersion !== 1 ||
        raw.platform !== platform ||
        !isDeepStrictEqual(identity(raw), childIdentity)
      )
        throw new Error(`${platform}: wrong source or platform`);
      const engine = record(raw.engine);
      if (
        !['digest', 'wasm', 'binding', 'table'].every((k) => digest(engine[k])) ||
        raw.nodeVersion !== process.version
      )
        throw new Error(`${platform}: missing engine identity or wrong pinned Node`);
      if (record(raw.corpus).sha256 !== corpusSha256 || !Array.isArray(raw.entries))
        throw new Error(`${platform}: wrong corpus or missing entries`);
      if (!isDeepStrictEqual(raw.entries.map((e: unknown) => record(e).id).sort(), expectedIds))
        throw new Error(`${platform}: missing, duplicate or extra fixture`);
      const rows: unknown[] = [];
      for (const fixed of expected) {
        const entry = record(raw.entries.find((e: unknown) => record(e).id === fixed.id));
        if (
          !isDeepStrictEqual(entry.identity, fixed.identity) ||
          !isDeepStrictEqual(entry.contract, corpus.contract)
        )
          throw new Error(`${platform}: input/contract drift: ${String(fixed.id)}`);
        if (
          entry.inputError !== null ||
          entry.runError !== null ||
          !['contractDifferences', 'identityDifferences', 'repeatDifferences'].every(
            (k) => Array.isArray(entry[k]) && entry[k].length === 0,
          ) ||
          !Array.isArray(entry.runs) ||
          entry.runs.length !== 2
        )
          throw new Error(`${platform}: incomplete fixture: ${String(fixed.id)}`);
        for (const result of entry.runs) {
          const run = record(result);
          if (
            ![
              'simulationHash',
              'eventHash',
              'trajectoryHash',
              'tsStateHash',
              'physicsStateHash',
            ].every((k) => digest(run[k])) ||
            run.simulationHash !== entry.simulationHash ||
            !Number.isSafeInteger(run.steps) ||
            !['win', 'draw', 'unresolved', 'truncated'].includes(String(record(run.outcome).kind))
          )
            throw new Error(`${platform}: invalid result`);
          record(run.stats);
        }
        if (!isDeepStrictEqual(entry.runs[0], entry.runs[1])) {
          check.status = 'fail';
          throw new Error(`${platform}: repeated result differs`);
        }
        rows.push({ id: fixed.id, result: entry.runs[0] });
      }
      results.push([raw.engine, raw.nodeVersion, ...rows]);
      check.evidence.push({
        uri: `.generated/harness/ci/evidence/${platform === 'linux' ? 'ubuntu-latest' : 'windows-latest'}/corpus/results.json`,
        sourceSha: info.sourceSha,
      });
    }
    check.status = isDeepStrictEqual(results[0], results[1]) ? 'pass' : 'fail';
    check.reason =
      check.status === 'pass'
        ? `${expected.length} fixed inputs: Linux/Windows result, event, trajectory, TS and physics digests agree`
        : 'Linux/Windows engine, toolchain or output differs for the same fixed inputs';
  } catch (error) {
    check.reason = error instanceof Error ? error.message : 'Invalid corpus evidence';
  }
  return check;
}
