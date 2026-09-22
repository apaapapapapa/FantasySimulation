import { describe, expect, it } from 'vite-plus/test';
import { compareCorpus } from './corpus-compare.ts';
import { corpusEvidence } from './test-support/corpus.ts';

const info = {
  sourceSha: 'a'.repeat(40),
  candidateSha: 'b'.repeat(40),
  baselineSha: 'c'.repeat(40),
  testMergeSha: 'a'.repeat(40),
};
describe('cross OS corpus comparison', () => {
  it('compares each expected input and rejects missing, stale or changed evidence', () => {
    const fixture = corpusEvidence(info);
    const compare = (value: typeof fixture) =>
      compareCorpus(info, value.definition, value.sha256, value.artifacts);
    expect(compare(fixture).status).toBe('pass');
    for (const edit of [
      (v: typeof fixture) => {
        v.artifacts.win32.results.entries.pop();
      },
      (v: typeof fixture) => {
        v.artifacts.win32.results.entries.push(v.artifacts.win32.results.entries[0]!);
      },
      (v: typeof fixture) => {
        v.artifacts.win32.results.sourceSha = 'd'.repeat(40);
      },
      (v: typeof fixture) => {
        v.artifacts.win32.results.corpus.sha256 = 'e'.repeat(64);
      },
      (v: typeof fixture) => {
        v.artifacts.win32.results.entries[0]!.runs.pop();
      },
      (v: typeof fixture) => {
        v.artifacts.win32.report.checks[0]!.status = 'unknown';
      },
    ]) {
      const changed = structuredClone(fixture);
      edit(changed);
      expect(compare(changed).status).toBe('unknown');
    }
    expect(
      compareCorpus(info, fixture.definition, fixture.sha256, { linux: fixture.artifacts.linux })
        .status,
    ).toBe('unknown');
    for (const run of fixture.artifacts.win32.results.entries[0]!.runs)
      run.physicsStateHash = `sha256:${'f'.repeat(64)}`;
    expect(compare(fixture).status).toBe('fail');
  });
});
