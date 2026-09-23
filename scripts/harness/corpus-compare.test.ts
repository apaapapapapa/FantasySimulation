import { describe, expect, it } from 'vite-plus/test';
import { compareCorpus } from './corpus-compare.ts';
import { corpusEvidence } from './test-support/corpus.ts';

const info = {
  sourceSha: 'a'.repeat(40),
  candidateSha: 'b'.repeat(40),
  baselineSha: 'c'.repeat(40),
  testMergeSha: 'a'.repeat(40),
};
describe('Linux corpus artifact validation', () => {
  it('compares each expected input and rejects missing, stale or changed evidence', () => {
    const fixture = corpusEvidence(info);
    const compare = (value: typeof fixture) =>
      compareCorpus(info, value.definition, value.sha256, value.artifacts);
    expect(compare(fixture).status).toBe('pass');
    for (const edit of [
      (v: typeof fixture) => {
        v.artifacts.linux.results.entries.pop();
      },
      (v: typeof fixture) => {
        v.artifacts.linux.results.entries.push(v.artifacts.linux.results.entries[0]!);
      },
      (v: typeof fixture) => {
        v.artifacts.linux.results.sourceSha = 'd'.repeat(40);
      },
      (v: typeof fixture) => {
        v.artifacts.linux.results.corpus.sha256 = 'e'.repeat(64);
      },
      (v: typeof fixture) => {
        v.artifacts.linux.results.entries[0]!.runs.pop();
      },
      (v: typeof fixture) => {
        v.artifacts.linux.report.checks[0]!.status = 'unknown';
      },
      (v: typeof fixture) => {
        v.artifacts.linux.results.platform = 'win32';
      },
    ]) {
      const changed = structuredClone(fixture);
      edit(changed);
      expect(compare(changed).status).toBe('unknown');
    }
    expect(compareCorpus(info, fixture.definition, fixture.sha256, {}).status).toBe('unknown');
    expect(
      compareCorpus(info, fixture.definition, fixture.sha256, { win32: fixture.artifacts.linux })
        .status,
    ).toBe('unknown');
    fixture.artifacts.linux.results.entries[0]!.runs[1]!.physicsStateHash = `sha256:${'f'.repeat(64)}`;
    expect(compare(fixture).status).toBe('fail');
  });
});
