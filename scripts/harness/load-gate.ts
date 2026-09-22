import { isDeepStrictEqual } from 'node:util';
import { COST_KEYS, capture, bytesHash, type Capture, type LoadProfile } from './load-contract.ts';
import { record, text, sha, evidenceUri, type Check, type Identity } from './report.ts';

export function costDigest(profile: unknown, corpusHash: string, observed: Capture): string {
  return bytesHash(
    JSON.stringify({
      profile,
      corpusHash,
      costs: Object.keys(record(record(profile).limits))
        .sort()
        .map((id) => ({ id, costs: observed.samples.find((s) => s.id === id)?.costs ?? null })),
    }),
  );
}
export function loadChecks(
  value: unknown,
  profile: LoadProfile,
  expected: {
    sourceSha: string;
    driverSha: string;
    corpusHash: string;
    profileHash: string;
    samples: number;
  },
): Check[] {
  let status: Check['status'] = 'unknown',
    reason = 'Missing load evidence';
  try {
    const observed = capture(value);
    for (const key of ['sourceSha', 'driverSha', 'corpusHash', 'profileHash'] as const)
      if (observed[key] !== expected[key]) throw new Error(`Stale load identity: ${key}`);
    if (observed.samples.length !== Object.keys(profile.limits).length * expected.samples)
      throw new Error('Incomplete sample coverage');
    const failures: string[] = [];
    for (const [id, limits] of Object.entries(profile.limits)) {
      const samples = observed.samples.filter((s) => s.id === id);
      if (samples.length !== expected.samples) throw new Error(`Missing/extra profile: ${id}`);
      if (
        !samples.every(
          (s) =>
            s.inputHash === samples[0]!.inputHash && isDeepStrictEqual(s.costs, samples[0]!.costs),
        )
      )
        throw new Error(`Unstable inputs/metrics: ${id}`);
      for (const sample of samples) {
        if (!['win', 'draw'].includes(sample.outcome)) failures.push(`${id}: ${sample.outcome}`);
        for (const key of COST_KEYS)
          if (sample.costs[key] > limits[key])
            failures.push(`${id}.${key}=${sample.costs[key]}>${limits[key]}`);
      }
    }
    status = failures.length ? 'fail' : 'pass';
    reason = failures.length
      ? [...new Set(failures)].join('; ')
      : 'All fixed profiles completed within deterministic count/byte ceilings';
  } catch (error) {
    reason = error instanceof Error ? error.message : reason;
  }
  return [
    {
      id: 'load:budget',
      required: true,
      status,
      reason,
      evidence: [{ uri: '.generated/harness/load/results.json', sourceSha: expected.sourceSha }],
    },
  ];
}

/** Review is exact-base and observation/profile bound; it cannot convert missing/failed runs to success. */
export function compareLoad(
  info: Identity,
  before: Capture,
  after: Capture,
  beforeProfile: unknown,
  profile: LoadProfile,
  reviews: unknown,
): Check[] {
  const evidence = [
    { uri: '.generated/harness/load-pair/results.json', sourceSha: info.sourceSha },
  ];
  const checks: Check[] = [];
  let status: Check['status'] = 'unknown',
    reason = 'Missing paired comparison';
  try {
    capture(before);
    capture(after);
    if (
      before.runnerId !== after.runnerId ||
      before.sourceSha !== info.baselineSha ||
      after.sourceSha !== info.sourceSha ||
      before.driverSha !== info.sourceSha ||
      after.driverSha !== info.sourceSha ||
      before.driverHash !== after.driverHash ||
      before.profileHash !== after.profileHash ||
      before.corpusHash !== after.corpusHash
    )
      throw new Error('Different SHA, driver, corpus or profile');
    for (const key of ['node', 'packageManager', 'platform', 'arch', 'cpu', 'cores'] as const)
      if (before.toolchain[key] !== after.toolchain[key])
        throw new Error(`Unpaired execution environment: ${key}`);
    for (const [observed, limits] of [
      [before, beforeProfile ?? profile],
      [after, profile],
    ] as const) {
      if (
        loadChecks(observed, limits as LoadProfile, {
          sourceSha: observed.sourceSha,
          driverSha: info.sourceSha,
          corpusHash: after.corpusHash,
          profileHash: after.profileHash,
          samples: profile.samples,
        }).some((c) => c.status !== 'pass')
      )
        throw new Error('Failed or incomplete baseline/candidate cannot be reviewed away');
    }
    for (const id of Object.keys(profile.limits)) {
      const left = before.samples.filter((s) => s.id === id),
        right = after.samples.filter((s) => s.id === id);
      if (left.length !== profile.samples || right.length !== profile.samples)
        throw new Error(`Incomplete paired trials: ${id}`);
      if (left.some((s) => s.inputHash !== right[0]!.inputHash))
        throw new Error(`Different fixed input: ${id}`);
    }
    const beforeDigest = costDigest(beforeProfile ?? profile, before.corpusHash, before);
    const afterDigest = costDigest(profile, after.corpusHash, after);
    const introduction = beforeProfile === null;
    const changed = introduction || beforeDigest !== afterDigest;
    if (changed) {
      if (reviews === null) throw new Error('Missing profile/cost review');
      const data = record(reviews);
      if (data.schemaVersion !== 1 || !Array.isArray(data.reviews))
        throw new Error('Missing profile/cost review');
      const matches = data.reviews
        .map(record)
        .filter(
          (review) =>
            sha(review.baselineSha) === info.baselineSha &&
            review.beforeDigest === beforeDigest &&
            review.afterDigest === afterDigest &&
            review.introduction === introduction,
        );
      if (matches.length !== 1) throw new Error('Unreviewed profile or cost change');
      const review = matches[0]!;
      if (
        text(review.reason).length < 30 ||
        !Array.isArray(review.evidence) ||
        review.evidence.length < 2
      )
        throw new Error('Review requires reason and before/after evidence');
      review.evidence.forEach(evidenceUri);
      text(review.reviewer);
    }
    status = 'pass';
    reason = changed
      ? 'Exact-baseline review binds observed before/after counts and ceilings'
      : 'Same profile and deterministic costs; paired raw timings retained for observation';
  } catch (error) {
    reason = error instanceof Error ? error.message : reason;
  }
  checks.push({ id: 'load:comparison', required: true, status, reason, evidence });
  return checks;
}
