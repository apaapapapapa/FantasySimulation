import { z } from 'zod';
import { validateCalibrationBudget } from './league-runner-calibration-policy.ts';
import {
  SEGMENT_SERVICE_HTTP_REQUESTS,
  SEGMENT_SERVICE_UPLOAD_BYTES,
} from './league-segment-service-bounds.ts';
import { TransportReservation } from './league-transport-reservation.ts';

/** Diagnostic bounds, not production admission or authenticated billing evidence.
 * Fixed child transport guard limits primary to 26 and metrics to 18 request creations.
 * Redirects/retries consume the same finite counters; overrun terminates before request creation.
 * Bootstrap: run + three artifact pages + redirect + storage GET <= 6,
 * reserved as 8. All other authenticated metadata remains inside the 40 share.
 */
export const SEGMENT_SERVICE_LIMITS = Object.freeze({
  matches: 144,
  partitions: 2,
  runners: 1,
  workers: 2,
  queueUnits: 2,
  queueBytes: 64 * 1024 ** 2,
  processRssBytes: 1024 ** 3,
  minimumFreeDiskBytes: 1024 ** 3,
  payloadBytes: 16 * 1024 ** 2,
  encodedSegmentBytes: SEGMENT_SERVICE_UPLOAD_BYTES.data,
  encodedMetricsBytes: SEGMENT_SERVICE_UPLOAD_BYTES.metrics,
  totalReservedBytes: 34079504,
  allocationRefs: 3,
  retentionDays: 1,
  runAttempt: 1,
  applicationRetries: 0,
  sdkConcurrency: 1,
  sdkBufferBytes: 8 * 1024 ** 2,
  primaryHttpRequests: SEGMENT_SERVICE_HTTP_REQUESTS.data,
  metricsHttpRequests: SEGMENT_SERVICE_HTTP_REQUESTS.metrics,
  bootstrapHttpRequests: 8,
  metadataRequests: 40,
  downloadHttpRequests: 2,
  httpRequestsUpper: 94,
  pipelineHttpRequestsUpper: 200,
  metadataTotalBudget: 94,
  reservedAdditional: 54,
  jobRefsUpper: 50,
  globalRefsUpper: 256,
});

/** Retains the existing, larger 92 MiB/day owner-attested headroom requirement. */
export function validateSegmentServiceBudget(input: unknown, sourceSha: string, now = Date.now()) {
  return validateCalibrationBudget(input, sourceSha, now);
}

const admissionSchema = z.strictObject({
  runAttempt: z.literal(1),
  // Authenticated metadata total_count, including previous/control/uncertain refs.
  existingArtifacts: z.number().int().min(0).max(256),
});

/** Caller owns authenticated inventory/source/original 144-match checks. No allocations here.
 * The single-job diagnostic conservatively charges every retained same-run ref to
 * this job as well, rather than silently excluding prior control allocations.
 * RSS/free disk reuse league-pilot-command limits; queueBytes is a separate bound.
 */
export function segmentServiceAdmission(input: unknown) {
  const admitted = admissionSchema.parse(input);
  const refs = admitted.existingArtifacts + SEGMENT_SERVICE_LIMITS.allocationRefs;
  if (refs > SEGMENT_SERVICE_LIMITS.globalRefsUpper || refs > SEGMENT_SERVICE_LIMITS.jobRefsUpper)
    throw new Error('Segment service retained artifact reservation exceeds finite quota');
  return {
    reservation: new TransportReservation(
      SEGMENT_SERVICE_LIMITS.allocationRefs,
      SEGMENT_SERVICE_LIMITS.totalReservedBytes,
    ),
    existingArtifacts: admitted.existingArtifacts,
    globalRefsUpper: refs,
    httpRequestsUpper: SEGMENT_SERVICE_LIMITS.httpRequestsUpper,
    executionEnabled: false as const,
  };
}
