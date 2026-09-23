import { isDeepStrictEqual } from 'node:util';
import { COST_KEYS, capture, bytesHash, type Capture, type LoadProfile } from './load-contract.ts';
import {
  assessReport,
  record,
  text,
  sha,
  evidenceUri,
  type Check,
  type Identity,
} from './report.ts';

export type LoadSeries = Pick<Capture, 'samples' | 'fixtureHash'> & {
  toolchain: Pick<Capture['toolchain'], 'node' | 'packageManager'>;
};
export function costDigest(profile: unknown, corpusHash: string, observed: LoadSeries): string {
  return bytesHash(
    JSON.stringify({
      profile,
      corpusHash,
      runtime: { node: observed.toolchain.node, packageManager: observed.toolchain.packageManager },
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
    requireCommitted?: boolean;
    caseIds?: readonly string[];
  },
): Check[] {
  let status: Check['status'] = 'unknown',
    reason = 'Missing load evidence';
  try {
    const observed = capture(value);
    if (expected.requireCommitted !== false && observed.sourceState !== 'clean')
      throw new Error('Working-tree verification is not committed evidence');
    for (const key of ['sourceSha', 'driverSha', 'corpusHash', 'profileHash'] as const)
      if (observed[key] !== expected[key]) throw new Error(`Stale load identity: ${key}`);
    const ids = expected.caseIds ?? Object.keys(profile.limits);
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !profile.limits[id]) ||
      observed.samples.some((sample) => !ids.includes(sample.id)) ||
      observed.samples.length !== ids.length * expected.samples
    )
      throw new Error('Incomplete sample coverage');
    const failures: string[] = [];
    for (const id of ids) {
      const limits = profile.limits[id]!;
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
export function compareLoadSeries(
  info: Identity,
  before: LoadSeries,
  after: LoadSeries,
  beforeProfile: unknown,
  profile: LoadProfile,
  reviews: unknown,
  boundary: unknown = null,
): Check[] {
  const evidence = [
    { uri: '.generated/harness/load-pair/results.json', sourceSha: info.sourceSha },
  ];
  const checks: Check[] = [];
  let status: Check['status'] = 'unknown',
    reason = 'Missing paired comparison';
  try {
    const comparable =
      before.fixtureHash === after.fixtureHash &&
      isDeepStrictEqual(beforeProfile ?? profile, profile) &&
      before.toolchain.node === after.toolchain.node &&
      before.toolchain.packageManager === after.toolchain.packageManager;
    if (comparable)
      for (const id of Object.keys(profile.limits)) {
        const left = before.samples.filter((s) => s.id === id),
          right = after.samples.filter((s) => s.id === id);
        if (left.length !== profile.samples || right.length !== profile.samples)
          throw new Error(`Incomplete paired trials: ${id}`);
        if (left.some((s) => s.inputHash !== right[0]!.inputHash))
          throw new Error(`Different fixed input: ${id}`);
      }
    const beforeDigest = costDigest(beforeProfile ?? profile, before.fixtureHash, before);
    const afterDigest = costDigest(profile, after.fixtureHash, after);
    const introduction = beforeProfile === null;
    const changed = introduction || !comparable || beforeDigest !== afterDigest;
    if (introduction || !comparable) {
      const coverage = assessReport(boundary, [
        'corpus:definition',
        'corpus:engine-identity',
        'corpus:identity',
        'corpus:repeat',
        'corpus:tests',
      ]);
      if (
        coverage.exitCode !== 0 ||
        coverage.report.producer !== 'corpus-runner' ||
        coverage.report.sourceSha !== info.sourceSha
      )
        throw new Error('Introduction/transition requires current independent boundary evidence');
    }
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
            review.introduction === introduction &&
            review.comparison === (comparable ? 'paired' : 'independent'),
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
      ? comparable
        ? 'Exact-baseline review binds observed before/after counts and ceilings'
        : 'Reviewed independent profile/toolchain transition; each revision passes its own pinned inputs and budgets, with candidate boundary evidence'
      : 'Same profile and deterministic costs; paired raw timings retained for observation';
    checks.push({
      id: 'load:paired-comparability',
      required: false,
      status: comparable ? 'pass' : 'unknown',
      reason: comparable
        ? 'Identical fixed inputs, profile and runtime pins'
        : 'Different fixed inputs, profile or runtime pins: no same-input or timing regression claim; no invented before values for new cases',
      evidence,
    });
  } catch (error) {
    reason = error instanceof Error ? error.message : reason;
  }
  checks.unshift({ id: 'load:comparison', required: true, status, reason, evidence });
  return checks;
}

export function validateLoadPair(
  info: Identity,
  before: Capture,
  after: Capture,
  beforeProfile: unknown,
  profile: LoadProfile,
  caseIds?: (profile: LoadProfile) => readonly string[],
) {
  capture(before);
  capture(after);
  if (
    before.runnerId !== after.runnerId ||
    before.sourceSha !== info.baselineSha ||
    after.sourceSha !== info.sourceSha ||
    before.driverSha !== info.sourceSha ||
    after.driverSha !== info.sourceSha ||
    before.driverHash !== after.driverHash
  )
    throw new Error('Different SHA or driver');
  for (const key of ['platform', 'arch', 'cpu', 'cores'] as const)
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
        corpusHash: observed.corpusHash,
        profileHash: observed.profileHash,
        samples: (limits as LoadProfile).samples,
        ...(caseIds ? { caseIds: caseIds(limits as LoadProfile) } : {}),
      }).some((c) => c.status !== 'pass')
    )
      throw new Error('Failed or incomplete baseline/candidate cannot be reviewed away');
  }
}
export function compareLoad(
  info: Identity,
  before: Capture,
  after: Capture,
  beforeProfile: unknown,
  profile: LoadProfile,
  reviews: unknown,
  boundary: unknown = null,
): Check[] {
  try {
    validateLoadPair(info, before, after, beforeProfile, profile);
  } catch (error) {
    return [
      {
        id: 'load:comparison',
        required: true,
        status: 'unknown',
        reason: error instanceof Error ? error.message : 'Invalid paired captures',
        evidence: [],
      },
    ];
  }
  return compareLoadSeries(info, before, after, beforeProfile, profile, reviews, boundary);
}
