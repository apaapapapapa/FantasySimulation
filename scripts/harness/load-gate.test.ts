import { describe, expect, it } from 'vite-plus/test';
import { loadChecks, compareLoad } from './load-gate.ts';
import { COST_KEYS } from './load-contract.ts';
import { loadFixture, loadReview, loadBoundary } from './test-support/load.ts';

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
    const reviews = loadReview(info, before, after, profile, profile);
    expect(compareLoad(info, before, after, profile, profile, reviews)[0]!.status).toBe('pass');
    before.samples[0]!.outcome = 'truncated';
    expect(compareLoad(info, before, after, profile, profile, reviews)[0]!.status).toBe('unknown');
  });
  it('does not compare timings from unrelated runner sessions', () => {
    const { before, after, profile, info } = loadFixture();
    after.runnerId = 'other-session';
    expect(compareLoad(info, before, after, profile, profile, null)[0]!.status).toBe('unknown');
  });
  it('keeps working-tree verification separate from committed evidence', () => {
    const { after, profile, expected } = loadFixture();
    after.sourceState = 'working-tree';
    expect(loadChecks(after, profile, expected)[0]!.status).toBe('unknown');
    expect(loadChecks(after, profile, { ...expected, requireCommitted: false })[0]!.status).toBe(
      'pass',
    );
  });
  it('requires review and independent boundaries for corpus profile or runtime transitions', () => {
    for (const change of ['inputs', 'profile', 'node', 'pnpm']) {
      const { before, after, profile, info } = loadFixture();
      const nextProfile = structuredClone(profile);
      if (change === 'inputs') {
        after.fixtureHash = 'e'.repeat(64);
        after.corpusHash = 'e'.repeat(64);
        for (const sample of after.samples) sample.inputHash = 'new-fixed-input';
      } else if (change === 'profile') {
        nextProfile.limits.battle!.steps++;
        after.profileHash = 'f'.repeat(64);
      } else if (change === 'node') before.toolchain.node = 'v24.18.0';
      else before.toolchain.packageManager = 'pnpm@11.18.0';
      const reviews = loadReview(info, before, after, profile, nextProfile, 'independent');
      const boundary = loadBoundary(info);
      expect(
        compareLoad(info, before, after, profile, nextProfile, null, boundary)[0]!.status,
      ).toBe('unknown');
      expect(compareLoad(info, before, after, profile, nextProfile, reviews)[0]!.status).toBe(
        'unknown',
      );
      expect(
        compareLoad(info, before, after, profile, nextProfile, reviews, {
          ...boundary,
          sourceSha: 'f'.repeat(40),
        })[0]!.status,
      ).toBe('unknown');
      const accepted = compareLoad(info, before, after, profile, nextProfile, reviews, boundary);
      expect(accepted[0]!.status).toBe('pass');
      expect(accepted.find((check) => check.id === 'load:paired-comparability')).toMatchObject({
        required: false,
        status: 'unknown',
      });
      before.samples[0]!.outcome = 'truncated';
      expect(
        compareLoad(info, before, after, profile, nextProfile, reviews, boundary)[0]!.status,
      ).toBe('unknown');
    }
  });
});
