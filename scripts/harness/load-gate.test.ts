import { describe, expect, it } from 'vite-plus/test';
import { loadChecks, compareLoad, costDigest } from './load-gate.ts';
import { COST_KEYS } from './load-contract.ts';
import { loadFixture } from './test-support/load.ts';

describe('load evidence gate', () => {
  it('rejects each missing or over-budget counter instead of zero filling', () => {
    const { after, profile, expected } = loadFixture();
    expect(loadChecks(after, profile, expected)[0]!.status).toBe('pass');
    for (const key of COST_KEYS) {
      const increased = structuredClone(after);
      for (const sample of increased.samples) sample.costs[key] = profile.limits.battle![key] + 1;
      expect(loadChecks(increased, profile, expected)[0]!.status).toBe('fail');
      const missing = JSON.parse(JSON.stringify(after)) as {
        samples: { costs: Record<string, unknown> }[];
      };
      delete missing.samples[0]!.costs[key];
      expect(loadChecks(missing, profile, expected)[0]!.status).toBe('unknown');
    }
  });
  it('refuses stale SHAs, missing samples, profile drift and truncation', () => {
    const { after, profile, expected } = loadFixture();
    for (const edit of [
      (r: typeof after) => {
        r.sourceSha = 'f'.repeat(40);
      },
      (r: typeof after) => {
        r.samples.pop();
      },
      (r: typeof after) => {
        r.samples[0]!.id = 'uncovered';
      },
      (r: typeof after) => {
        r.profileHash = 'f'.repeat(64);
      },
    ]) {
      const raw = structuredClone(after);
      edit(raw);
      expect(loadChecks(raw, profile, expected)[0]!.status).toBe('unknown');
    }
    after.samples[0]!.outcome = 'truncated';
    expect(loadChecks(after, profile, expected)[0]!.status).toBe('fail');
  });
  it('requires exact before and after review for changed costs and ceilings', () => {
    const { before, after, profile, info } = loadFixture();
    expect(compareLoad(info, before, after, profile, profile, null)[0]!.status).toBe('pass');
    for (const sample of after.samples) sample.costs.logBytes++;
    expect(compareLoad(info, before, after, profile, profile, null)[0]!.status).toBe('unknown');
    const reviews = {
      schemaVersion: 1,
      reviews: [
        {
          baselineSha: info.baselineSha,
          beforeDigest: costDigest(profile, before.corpusHash, before),
          afterDigest: costDigest(profile, after.corpusHash, after),
          introduction: false,
          reviewer: 'test reviewer',
          reason: 'Reviewed intentional additional event bytes with before and after raw evidence.',
          evidence: [
            '.generated/harness/load-pair/0-before.json',
            '.generated/harness/load-pair/0-after.json',
          ],
        },
      ],
    };
    expect(compareLoad(info, before, after, profile, profile, reviews)[0]!.status).toBe('pass');
    before.samples[0]!.outcome = 'truncated';
    expect(compareLoad(info, before, after, profile, profile, reviews)[0]!.status).toBe('unknown');
  });
  it('does not compare timings from unrelated runner sessions', () => {
    const { before, after, profile, info } = loadFixture();
    after.runnerId = 'other-session';
    expect(compareLoad(info, before, after, profile, profile, null)[0]!.status).toBe('unknown');
  });
});
