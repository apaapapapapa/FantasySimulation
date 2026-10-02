import { z } from 'zod';
import { PUBLICATION_MAX_BYTES } from '@fantasy/domain/spatial';
import { CALIBRATION_LIMITS, calibrationRunners } from './league-runner-calibration-policy.ts';

/** Application allocation attempts, not a claim about SDK HTTP retries or service quota. */
export class TransportReservation {
  private readonly names = new Set<string>();
  private bytes = 0;
  constructor(
    private readonly refsUpper: number,
    private readonly bytesUpper: number,
  ) {
    z.number().int().min(1).max(50).parse(refsUpper);
    z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).parse(bytesUpper);
  }
  /** Synchronous debit before allocation; failed/uncertain allocations never refund. */
  reserve(name: string, bytes: number) {
    z.string().min(1).max(256).parse(name);
    z.number().int().positive().safe().parse(bytes);
    if (this.names.has(name)) throw new Error('Transport immutable allocation name reused');
    if (this.names.size + 1 > this.refsUpper || bytes > this.bytesUpper - this.bytes)
      throw new Error('Transport job reservation exhausted before service allocation');
    this.names.add(name);
    this.bytes += bytes;
  }
  snapshot() {
    return {
      refsUpper: this.refsUpper,
      bytesUpper: this.bytesUpper,
      reservedRefs: this.names.size,
      reservedBytes: this.bytes,
      refundable: false as const,
    };
  }
}

/** Fixed workflow job shares are reserved before preparation/simulation, not inferred from output. */
export function calibrationTransportReservation(
  command: string,
  runners: number,
  existingArtifacts: number,
) {
  calibrationRunners(runners);
  z.number().int().min(0).max(256).parse(existingArtifacts);
  const payloadRefs = 16;
  const job = {
    prepare: {
      refs: 3,
      bytes: 2 * CALIBRATION_LIMITS.encodedSharedBytes + CALIBRATION_LIMITS.encodedMetricsBytes,
    },
    compute: {
      refs: payloadRefs + 2,
      bytes:
        (4 / runners) * CALIBRATION_LIMITS.encodedPartitionBytes +
        CALIBRATION_LIMITS.encodedTerminalBytes +
        CALIBRATION_LIMITS.encodedMetricsBytes,
    },
    consume: { refs: 1, bytes: CALIBRATION_LIMITS.encodedMetricsBytes },
  }[command];
  if (!job) throw new Error('Unknown calibration transport job');
  const globalRefsUpper = existingArtifacts + runners * (payloadRefs + 2) + 4;
  if (job.refs > 32 || globalRefsUpper > 256)
    throw new Error('Calibration immutable artifact quota exceeded');
  return { ledger: new TransportReservation(job.refs, job.bytes), globalRefsUpper };
}

export const MULTIPART_LIMITS = Object.freeze({
  partitions: 64,
  partitionsPerRunner: 16,
  runners: 4,
  jobRefs: 50,
  globalRefs: 256,
  rawSegmentBytes: 48 * 1024 ** 2,
  segmentHeaderBytes: 256,
  controlBytesPerPartition: 16 * 1024 ** 2,
  framingBytesPerPartition: 4 * 1024 ** 2,
  retryRefsPerRunner: 1,
  runnerControlRefs: 2,
  sharedRefs: 5,
});

/** Hard quota plan only: output exceeding a share must fail, never drop records.
 * No encoder, execution, SDK HTTP retry, cost or <=270s authority is granted here.
 */
export function multipartReservationPlan(partitions: unknown) {
  const assignments = z
    .array(z.array(z.number().int().min(0).max(63)).min(1).max(16))
    .min(1)
    .max(4)
    .parse(partitions);
  const coverage = assignments.flat();
  if (
    new Set(coverage).size !== coverage.length ||
    coverage.length > MULTIPART_LIMITS.partitions ||
    [...coverage].sort((a, b) => a - b).some((value, index) => value !== index)
  )
    throw new Error('Multipart canonical partition coverage required');
  const payloadBytes = MULTIPART_LIMITS.rawSegmentBytes - MULTIPART_LIMITS.segmentHeaderBytes;
  const encodedSegmentBytesUpper =
    MULTIPART_LIMITS.rawSegmentBytes + 92 + 2 * Buffer.byteLength('segment.bin') + 22;
  const jobs = assignments.map((parts, runner) => {
    const publicBytesUpper =
      Math.floor(PUBLICATION_MAX_BYTES / assignments.length) +
      (runner < PUBLICATION_MAX_BYTES % assignments.length ? 1 : 0);
    const logicalBytesUpper =
      publicBytesUpper +
      parts.length *
        (MULTIPART_LIMITS.controlBytesPerPartition + MULTIPART_LIMITS.framingBytesPerPartition);
    const payloadRefsUpper =
      Math.ceil(logicalBytesUpper / payloadBytes) + MULTIPART_LIMITS.retryRefsPerRunner;
    return {
      runner,
      partitions: [...parts],
      publicBytesUpper,
      logicalBytesUpper,
      payloadRefsUpper,
      jobRefsUpper: payloadRefsUpper + MULTIPART_LIMITS.runnerControlRefs,
      encodedPayloadBytesUpper: payloadRefsUpper * encodedSegmentBytesUpper,
      encodedJobBytesUpper:
        payloadRefsUpper * encodedSegmentBytesUpper +
        MULTIPART_LIMITS.runnerControlRefs * 4 * 1024 ** 2,
    };
  });
  const globalRefsUpper = jobs.reduce<number>(
    (n, job) => n + job.jobRefsUpper,
    MULTIPART_LIMITS.sharedRefs,
  );
  if (
    jobs.some((job) => job.jobRefsUpper > MULTIPART_LIMITS.jobRefs) ||
    globalRefsUpper > MULTIPART_LIMITS.globalRefs
  )
    throw new Error('Multipart reserved reference envelope exceeds finite quota');
  const encodedRunBytesUpper = jobs.reduce(
    (sum, job) => sum + job.encodedJobBytesUpper,
    MULTIPART_LIMITS.sharedRefs * 64 * 1024 ** 2,
  );
  return {
    schemaVersion: 3 as const,
    status: 'reservation-only' as const,
    executionEnabled: false as const,
    jobs,
    globalRefsUpper,
    encodedSegmentBytesUpper,
    encodedRunBytesUpper,
    retentionDays: 1,
    reservedByteHours: encodedRunBytesUpper * 24,
    remainingGates: [
      'enforced-runner-public-quota',
      'authenticated-runtime-closure',
      'sealed-segment-wire-protocol',
      'same-zip-sdk-upload',
      'authenticated-complete-receiver',
      'metadata-http-retry-lease-storage-budget',
      'same-source-whole-critical-path',
    ],
  };
}
