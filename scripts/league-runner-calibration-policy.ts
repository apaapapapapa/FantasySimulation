import { z } from 'zod';
import {
  canonicalJson,
  LeagueCloudPreparedSchema,
  type LeagueCloudPrepared,
} from '@fantasy/domain/spatial';
import type { PipelineIdentity } from '../apps/cli/src/league/league-producer.ts';

export function calibrationRunners(value: number): 2 | 4 {
  if (value !== 2 && value !== 4)
    throw new Error('Calibration requires exactly two or four runners');
  return value;
}

/** Scheduling scope only; original-input and fresh reservation checks belong to the assembler. */
export function requireCalibrationScope(
  input: LeagueCloudPrepared,
  runners: number,
  identity?: PipelineIdentity,
) {
  calibrationRunners(runners);
  const prepared = LeagueCloudPreparedSchema.parse(input);
  if (
    prepared.inputs.length !== 4 ||
    prepared.plan.partitions.length !== 4 ||
    prepared.plan.partitions.some((partition) => partition.slots !== 95) ||
    new Set(prepared.plan.partitions.map((partition) => partition.partitionId)).size !== 4
  )
    throw new Error('Calibration requires four distinct 95-match partitions');
  if (
    prepared.plan.revision.sourceSha !== prepared.plan.source.sha ||
    (identity &&
      (canonicalJson(prepared.plan.source) !== canonicalJson(identity.source) ||
        prepared.executionId !== `league-${identity.runId}-${identity.runAttempt}`))
  )
    throw new Error('Calibration source or execution identity mismatch');
}

export const CALIBRATION_BUDGET_EVIDENCE_URL = 'https://github.com/settings/billing/usage';
export const CALIBRATION_LIMITS = Object.freeze({
  partitions: 4,
  slotsPerPartition: 95,
  totalSlots: 380,
  workers: 2,
  retentionDays: 1,
  rawPartitionBytes: 15 * 1024 ** 2,
  encodedPartitionBytes: 20 * 1024 ** 2,
  rawSharedBytes: 3 * 1024 ** 2,
  encodedSharedBytes: 4 * 1024 ** 2,
  encodedMetricsBytes: 0.5 * 1024 ** 2,
  encodedTerminalBytes: 0.25 * 1024 ** 2,
  totalEncodedBytes: 92 * 1024 ** 2,
});
export const CALIBRATION_TRIAL_BYTE_HOURS = CALIBRATION_LIMITS.totalEncodedBytes * 24;
const safeBytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const observationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('owner-attestation'),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  accountLogin: z.literal('apaapapapapa'),
  observedAt: z.string().datetime(),
  retentionDays: z.literal(1),
  artifactByteHoursRemaining: safeBytes.positive(),
  competingWorkloadByteHours: safeBytes,
  reserveByteHours: safeBytes.positive(),
  readproofEvidenceURL: z.literal(CALIBRATION_BUDGET_EVIDENCE_URL),
});

/** An explicit owner's declaration, never authenticated API billing or quota proof. */
export function validateCalibrationBudget(input: unknown, sourceSha: string, now = Date.now()) {
  const observation = observationSchema.parse(input);
  const measuredAt = Date.parse(observation.observedAt);
  if (
    !Number.isSafeInteger(now) ||
    now < 1 ||
    !Number.isFinite(measuredAt) ||
    measuredAt > now ||
    now - measuredAt > 3600000 ||
    observation.sourceSha !== sourceSha
  )
    throw new Error('Calibration budget observation is stale, future or foreign');
  const remaining =
    BigInt(observation.artifactByteHoursRemaining) -
    BigInt(observation.competingWorkloadByteHours) -
    BigInt(observation.reserveByteHours);
  if (remaining < BigInt(CALIBRATION_TRIAL_BYTE_HOURS))
    throw new Error(
      'Calibration byte-hour headroom is insufficient after competing workload and reserves',
    );
  return {
    observation,
    remainingAfterReserves: Number(remaining),
    requiredByteHours: CALIBRATION_TRIAL_BYTE_HOURS,
  };
}

/** Authenticated workflow age closes admission; it never promises a terminal outcome within 30 minutes. */
export function calibrationRunRemaining(createdAt: unknown, now = Date.now()) {
  const created = Date.parse(z.string().datetime().parse(createdAt));
  const remaining = 30 * 60000 - (now - created);
  if (
    !Number.isSafeInteger(now) ||
    now < 1 ||
    created > now ||
    !Number.isSafeInteger(remaining) ||
    remaining <= 0
  )
    throw new Error('Calibration workflow creation deadline closed or unknown');
  return remaining;
}
