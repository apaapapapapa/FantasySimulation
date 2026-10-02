/** Fixed per-upload bounds shared by the policy, the parent supervisor and the guarded child.
 * The child imports this before installing its HTTP guard, so it must never import anything.
 */
export const SEGMENT_SERVICE_UPLOAD_NAME =
  /^league-[1-9][0-9]*-1-(segment-0-0-upload-0|service-metrics)\.zip$/;
export type SegmentServiceUploadKind = 'data' | 'metrics';
export const segmentServiceUploadKind = (name: string): SegmentServiceUploadKind =>
  name.endsWith('-service-metrics.zip') ? 'metrics' : 'data';
/** Request creations the child guard permits, including SDK redirects and retries. */
export const SEGMENT_SERVICE_HTTP_REQUESTS = Object.freeze({ data: 26, metrics: 18 } as const);
/** Encoded ZIP bytes accepted for one data segment or metrics upload. */
export const SEGMENT_SERVICE_UPLOAD_BYTES = Object.freeze({
  data: 16 * 1024 ** 2 + 392,
  metrics: 524288,
});
