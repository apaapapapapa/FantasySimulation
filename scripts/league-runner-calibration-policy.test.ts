import { expect, it } from 'vite-plus/test';
import { withReplayDirectory } from '@fantasy/api/testing';
import { preparedPipeline } from '../apps/cli/test-support/league-pipeline.ts';
import {
  calibrationRunners,
  requireCalibrationScope,
  validateCalibrationBudget,
  CALIBRATION_LIMITS,
} from './league-runner-calibration-policy.ts';

const sourceSha = 'a'.repeat(40),
  now = Date.UTC(2026, 9, 2);
function observation() {
  return {
    schemaVersion: 1,
    kind: 'owner-attestation',
    sourceSha,
    accountLogin: 'apaapapapapa',
    observedAt: new Date(now).toISOString(),
    retentionDays: 1,
    artifactByteHoursRemaining: 2315255808 + 3000,
    competingWorkloadByteHours: 1000,
    reserveByteHours: 2000,
    readproofEvidenceURL: 'https://github.com/settings/billing/usage',
  };
}

it('accepts exactly the declared post-reserve trial bound and finite freshness boundary', () => {
  const value = observation();
  expect(validateCalibrationBudget(value, sourceSha, now)).toMatchObject({
    requiredByteHours: 2315255808,
    remainingAfterReserves: 2315255808,
    observation: { kind: 'owner-attestation' },
  });
  value.observedAt = new Date(now - 3600000).toISOString();
  expect(() => validateCalibrationBudget(value, sourceSha, now)).not.toThrow();
});

it.each([
  ['missing', undefined],
  ['accountLogin', 'someone-else'],
  ['sourceSha', 'b'.repeat(40)],
  ['kind', 'api-proof'],
  ['observedAt', 'invalid'],
  ['observedAt', new Date(now + 1).toISOString()],
  ['observedAt', new Date(now - 3600001).toISOString()],
  ['retentionDays', 7],
  ['readproofEvidenceURL', 'https://example.com/settings/billing/usage'],
  ['readproofEvidenceURL', 'https://github.com/settings/billing/usage?claimed=true'],
  ['artifactByteHoursRemaining', 2315258807],
  ['artifactByteHoursRemaining', 0],
  ['artifactByteHoursRemaining', Number.MAX_SAFE_INTEGER + 1],
  ['competingWorkloadByteHours', -1],
  ['reserveByteHours', 0],
  ['reserveByteHours', NaN],
] as const)(
  'rejects unknown, stale, foreign or insufficient declaration: %s %s',
  (field, value) => {
    const candidate: Record<string, unknown> = observation();
    if (field === 'missing') delete candidate.reserveByteHours;
    else candidate[field] = value;
    expect(() => validateCalibrationBudget(candidate, sourceSha, now)).toThrow();
  },
);

it('does not overflow competing-workload/reserve arithmetic or accept undeclared fields', () => {
  expect(() =>
    validateCalibrationBudget(
      {
        ...observation(),
        artifactByteHoursRemaining: Number.MAX_SAFE_INTEGER,
        competingWorkloadByteHours: Number.MAX_SAFE_INTEGER,
        reserveByteHours: Number.MAX_SAFE_INTEGER,
      },
      sourceSha,
      now,
    ),
  ).toThrow('insufficient');
  expect(() =>
    validateCalibrationBudget({ ...observation(), apiVerified: true }, sourceSha, now),
  ).toThrow();
  expect(() => validateCalibrationBudget(observation(), sourceSha, NaN)).toThrow();
});

it.each([0, 1, 3, 5, 16, 32, 2.5, NaN])('rejects width %s', (width) => {
  expect(() => calibrationRunners(width)).toThrow('exactly two or four');
});

it('fixes diagnostic encoded/raw budgets and both accepted widths', () => {
  expect(calibrationRunners(2)).toBe(2);
  expect(calibrationRunners(4)).toBe(4);
  expect(CALIBRATION_LIMITS).toEqual({
    partitions: 4,
    slotsPerPartition: 95,
    totalSlots: 380,
    workers: 2,
    retentionDays: 1,
    rawPartitionBytes: 15728640,
    encodedPartitionBytes: 20971520,
    rawSharedBytes: 3145728,
    encodedSharedBytes: 4194304,
    encodedMetricsBytes: 524288,
    encodedTerminalBytes: 262144,
    totalEncodedBytes: 96468992,
  });
  expect(Object.isFrozen(CALIBRATION_LIMITS)).toBe(true);
});

it('checks scheduling scope and exact source/runtime/namespace without claiming fresh-input authentication', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await preparedPipeline(root);
    expect(() => requireCalibrationScope(fixture.prepared, 2, fixture.identity)).toThrow(
      'four distinct',
    );
    // A structural policy fixture, not a valid calculated plan or producer proof. The owning
    // assembler separately authenticates original inputs, all hashes and fresh reservations.
    const prepared = structuredClone(fixture.prepared);
    prepared.inputs = Array.from({ length: 4 }, () => ({ ...fixture.prepared.inputs[0]! }));
    prepared.plan.partitions = Array.from({ length: 4 }, (_, index) => ({
      ...fixture.prepared.plan.partitions[0]!,
      slots: 95,
      partitionId: 'sha256:' + String(index + 1).repeat(64),
    }));
    expect(() => requireCalibrationScope(prepared, 2, fixture.identity)).not.toThrow();
    expect(() => requireCalibrationScope(prepared, 4, fixture.identity)).not.toThrow();
    for (const source of [
      { ...fixture.identity.source, sha: 'd'.repeat(40) },
      { ...fixture.identity.source, node: 'different-runtime' },
    ])
      expect(() => requireCalibrationScope(prepared, 2, { ...fixture.identity, source })).toThrow(
        'identity',
      );
    const wrongNamespace = { ...fixture.identity, runAttempt: 2 };
    expect(() => requireCalibrationScope(prepared, 2, wrongNamespace)).toThrow('identity');
    const wrongCount = structuredClone(prepared);
    wrongCount.plan.partitions[0]!.slots = 96;
    expect(() => requireCalibrationScope(wrongCount, 2, fixture.identity)).toThrow('95');
    const duplicate = structuredClone(prepared);
    duplicate.plan.partitions[1]!.partitionId = duplicate.plan.partitions[0]!.partitionId;
    expect(() => requireCalibrationScope(duplicate, 2, fixture.identity)).toThrow('distinct');
  });
});

it('closes admission exactly at workflow age 30 minutes and rejects unknown or future clocks', async () => {
  const { calibrationRunRemaining } = await import('./league-runner-calibration-policy.ts');
  const created = Date.parse('2026-10-01T12:00:00.000Z');
  expect(calibrationRunRemaining('2026-10-01T12:00:00.000Z', created)).toBe(1800000);
  expect(calibrationRunRemaining('2026-10-01T12:00:00.000Z', created + 1799999)).toBe(1);
  for (const time of [created - 1, created + 1800000, created + 2400000, NaN])
    expect(() => calibrationRunRemaining('2026-10-01T12:00:00.000Z', time)).toThrow('deadline');
  expect(() => calibrationRunRemaining(undefined, created)).toThrow();
});
