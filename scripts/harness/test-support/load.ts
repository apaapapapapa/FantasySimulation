import type { Identity, Report } from '../report.ts';
import type { Capture, LoadProfile } from '../load-contract.ts';
import { costDigest } from '../load-gate.ts';

export function loadReview(
  info: Identity,
  before: Capture,
  after: Capture,
  beforeProfile: LoadProfile,
  profile: LoadProfile,
  comparison: 'paired' | 'independent' = 'paired',
) {
  return {
    schemaVersion: 1,
    reviews: [
      {
        baselineSha: info.baselineSha,
        beforeDigest: costDigest(beforeProfile, before.fixtureHash, before),
        afterDigest: costDigest(profile, after.fixtureHash, after),
        introduction: false,
        comparison,
        reviewer: 'test reviewer',
        reason:
          'Reviewed intentional profile/runtime change with actual before and after observations.',
        evidence: [
          '.generated/harness/load-pair/0-before.json',
          '.generated/harness/load-pair/0-after.json',
        ],
      },
    ],
  };
}
export function loadBoundary(info: Identity): Report {
  return {
    ...info,
    schemaVersion: 1,
    producer: 'corpus-runner',
    startedAt: '2026-09-22T00:00:00Z',
    finishedAt: '2026-09-22T00:00:01Z',
    checks: [
      'corpus:definition',
      'corpus:engine-identity',
      'corpus:identity',
      'corpus:repeat',
      'corpus:tests',
    ].map((id) => ({
      id,
      required: true,
      status: 'pass',
      reason: 'Synthetic independent boundary evidence',
      evidence: [{ uri: '.generated/harness/corpus/results.json', sourceSha: info.sourceSha }],
    })),
  };
}

export function loadReceipts(info: Identity) {
  return Object.fromEntries(
    ['load-ubuntu-latest', 'load-windows-latest', 'load-pair'].map((name) => [
      name,
      {
        ...info,
        schemaVersion: 1,
        producer: 'load-runner',
        startedAt: '2026-09-22T00:00:00Z',
        finishedAt: '2026-09-22T00:00:01Z',
        checks: (name === 'load-pair'
          ? [
              'load:budget:before',
              'load:budget:after',
              'load:comparison',
              'load:regression',
              'load:collection',
            ]
          : ['load:budget', 'load:collection']
        ).map((id) => ({
          id,
          required: true,
          status: 'pass',
          reason: 'Synthetic load receipt',
          evidence: [{ uri: '.generated/harness/load/results.json', sourceSha: info.sourceSha }],
        })),
      },
    ]),
  );
}
export function loadFixture() {
  const costs = {
    steps: 1,
    casts: 2,
    candidates: 3,
    pathNodes: 4,
    events: 5,
    logBytes: 6,
    trajectoryBytes: 7,
  };
  const profile: LoadProfile = {
    schemaVersion: 1,
    id: 'fixed',
    warmups: 1,
    samples: 5,
    limits: {
      battle: {
        steps: 2,
        casts: 4,
        candidates: 6,
        pathNodes: 8,
        events: 10,
        logBytes: 12,
        trajectoryBytes: 14,
      },
    },
  };
  const info: Identity = {
    sourceSha: 'a'.repeat(40),
    candidateSha: 'a'.repeat(40),
    baselineSha: 'b'.repeat(40),
    testMergeSha: null,
  };
  const after: Capture = {
    schemaVersion: 1,
    sourceState: 'clean',
    runnerId: 'paired-session',
    sourceSha: info.sourceSha,
    driverSha: info.sourceSha,
    driverHash: 'c'.repeat(64),
    corpusHash: 'd'.repeat(64),
    fixtureHash: 'd'.repeat(64),
    profileHash: 'e'.repeat(64),
    engine: { digest: 'engine' },
    toolchain: {
      node: process.version,
      packageManager: 'pnpm@11.19.0',
      lockHash: 'f'.repeat(64),
      platform: 'linux',
      arch: 'x64',
      cpu: 'fixture',
      cores: 4,
    },
    samples: Array.from({ length: 5 }, () => ({
      id: 'battle',
      inputHash: 'fixed',
      outcome: 'draw',
      costs: { ...costs },
      elapsedMs: 1,
      cpuMicros: 500,
      peakRssBytes: 2000,
      memoryReason: null,
    })),
  };
  const before = { ...structuredClone(after), sourceSha: info.baselineSha! };
  const expected = {
    sourceSha: info.sourceSha,
    driverSha: info.sourceSha,
    corpusHash: after.corpusHash,
    profileHash: after.profileHash,
    samples: 5,
  };
  return { profile, info, before, after, expected };
}
