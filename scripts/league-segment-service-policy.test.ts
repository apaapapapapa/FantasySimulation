import { expect, it } from 'vite-plus/test';
import {
  SEGMENT_SERVICE_LIMITS,
  segmentServiceAdmission,
  validateSegmentServiceBudget,
} from './league-segment-service-policy.ts';

const sourceSha = 'a'.repeat(40),
  now = Date.UTC(2026, 9, 2);
function budget(ageMs = 0, headroom = 2315255808) {
  const identity = {
    schemaVersion: 1,
    kind: 'owner-attestation',
    sourceSha,
    accountLogin: 'apaapapapapa',
  };
  const evidence = {
    observedAt: new Date(now - ageMs).toISOString(),
    retentionDays: 1,
    readproofEvidenceURL: 'https://github.com/settings/billing/usage',
  };
  return {
    ...identity,
    ...evidence,
    artifactByteHoursRemaining: headroom + 3000,
    competingWorkloadByteHours: 1000,
    reserveByteHours: 2000,
  };
}

it('retains larger owner-attested calibration headroom and its inclusive one-hour boundary', () => {
  expect(validateSegmentServiceBudget(budget(3600000), sourceSha, now)).toMatchObject({
    requiredByteHours: 2315255808,
    remainingAfterReserves: 2315255808,
    observation: { kind: 'owner-attestation' },
  });
  expect(() => validateSegmentServiceBudget(budget(0, 2315255807), sourceSha, now)).toThrow();
  expect(() => validateSegmentServiceBudget(budget(3600001), sourceSha, now)).toThrow();
  expect(() => validateSegmentServiceBudget(budget(-1), sourceSha, now)).toThrow();
});

it.each([
  { field: 'sourceSha', value: 'b'.repeat(40) },
  { field: 'accountLogin', value: 'foreign' },
  { field: 'kind', value: 'authenticated-api-proof' },
  { field: 'retentionDays', value: 7 },
  { field: 'readproofEvidenceURL', value: 'https://example.com/usage' },
  { field: 'reserveByteHours', value: undefined },
  { field: 'competingWorkloadByteHours', value: undefined },
])('rejects unknown or foreign budget $field', ({ field, value }) => {
  expect(() =>
    validateSegmentServiceBudget({ ...budget(), [field]: value }, sourceSha, now),
  ).toThrow();
});

it('fixes separate queue/process/disk bounds and reserves both payload attempts plus metrics', () => {
  expect(Object.isFrozen(SEGMENT_SERVICE_LIMITS)).toBe(true);
  expect(SEGMENT_SERVICE_LIMITS).toMatchObject({
    matches: 144,
    partitions: 2,
    runners: 1,
    workers: 2,
    queueUnits: 2,
    queueBytes: 67108864,
    processRssBytes: 1073741824,
    minimumFreeDiskBytes: 1073741824,
    payloadBytes: 16777216,
    encodedSegmentBytes: 16777608,
    encodedMetricsBytes: 524288,
    totalReservedBytes: 34079504,
    allocationRefs: 3,
    applicationRetries: 0,
    retentionDays: 1,
    sdkConcurrency: 1,
    sdkBufferBytes: 8388608,
  });
  expect(SEGMENT_SERVICE_LIMITS.totalReservedBytes).toBe(2 * 16777608 + 524288);
  expect(
    SEGMENT_SERVICE_LIMITS.metadataTotalBudget - SEGMENT_SERVICE_LIMITS.reservedAdditional,
  ).toBe(40);
  expect(26 + 18 + 8 + 40 + 2).toBe(SEGMENT_SERVICE_LIMITS.httpRequestsUpper);
  expect(SEGMENT_SERVICE_LIMITS.metadataTotalBudget).toBeLessThanOrEqual(200);
});

it('admits the inclusive conservative retained-job boundary without doing allocations', () => {
  const admitted = segmentServiceAdmission({ runAttempt: 1, existingArtifacts: 47 });
  expect(admitted).toMatchObject({
    existingArtifacts: 47,
    globalRefsUpper: 50,
    httpRequestsUpper: 94,
    executionEnabled: false,
  });
  expect(admitted.reservation.snapshot()).toEqual({
    refsUpper: 3,
    bytesUpper: 34079504,
    reservedRefs: 0,
    reservedBytes: 0,
    refundable: false,
  });
});

it('keeps uncertain payload debit and metrics reserve even though application retries are disabled', () => {
  const { reservation } = segmentServiceAdmission({ runAttempt: 1, existingArtifacts: 0 });
  reservation.reserve('uncertain-primary.zip', 16777608);
  reservation.reserve('held-uncertain-budget.zip', 16777608);
  reservation.reserve('metrics.zip', 524288);
  expect(reservation.snapshot()).toMatchObject({
    reservedRefs: 3,
    reservedBytes: 34079504,
    refundable: false,
  });
  expect(() => reservation.reserve('extra.zip', 1)).toThrow();
  expect(() => reservation.reserve('uncertain-primary.zip', 1)).toThrow();
});

it.each([
  { runAttempt: 2, existingArtifacts: 0 },
  { runAttempt: 0, existingArtifacts: 0 },
  { runAttempt: 1, existingArtifacts: 48 },
  { runAttempt: 1, existingArtifacts: 254 },
  { runAttempt: 1, existingArtifacts: -1 },
  { runAttempt: 1, existingArtifacts: 0.5 },
  { runAttempt: 1, existingArtifacts: Number.NaN },
  { runAttempt: 1 },
  { runAttempt: 1, existingArtifacts: 0, applicationRetries: 1 },
  { runAttempt: 1, existingArtifacts: 0, metadataTotalBudget: 200 },
])('rejects unknown, repeated or excessive admission %j', (input) => {
  expect(() => segmentServiceAdmission(input)).toThrow();
});
