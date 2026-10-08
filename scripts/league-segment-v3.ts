import { createHash } from 'node:crypto';
import { canonicalJson, HashSchema, LeaguePipelineIdentitySchema } from '@fantasy/domain/spatial';
import { MULTIPART_LIMITS } from './league-transport-reservation.ts';

/** Codec only: no admission, archive authentication or execution authority. */
export const SEGMENT_V3_HEADER_BYTES = MULTIPART_LIMITS.segmentHeaderBytes;
export const SEGMENT_V3_PAYLOAD_BYTES = MULTIPART_LIMITS.rawSegmentBytes - SEGMENT_V3_HEADER_BYTES;
export const SEGMENT_V3_JOB_REFS = MULTIPART_LIMITS.jobRefs - MULTIPART_LIMITS.runnerControlRefs;
export const SEGMENT_V3_DATA_COUNT = SEGMENT_V3_JOB_REFS - MULTIPART_LIMITS.retryRefsPerRunner;
export const SEGMENT_V3_STREAM_BYTES = SEGMENT_V3_DATA_COUNT * SEGMENT_V3_PAYLOAD_BYTES;
const magic = Buffer.from('FSLSEG3\0', 'ascii');
type Identity = ReturnType<typeof LeaguePipelineIdentitySchema.parse>;
export type SegmentV3Binding = {
  identity: Identity;
  runner: number;
  index: number;
  count: number;
  totalBytes: number;
  planHash: string;
  inventoryHash: string;
  streamHash: string;
  runtimeHash: string;
};
export type SegmentV3Expected = SegmentV3Binding & { payloadHash: string };
export const segmentV3Hash = (bytes: Uint8Array): string =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
function checked(binding: SegmentV3Binding) {
  const identity = LeaguePipelineIdentitySchema.parse(binding.identity);
  if (
    !Number.isInteger(binding.runner) ||
    binding.runner < 0 ||
    binding.runner >= MULTIPART_LIMITS.runners ||
    !Number.isSafeInteger(binding.totalBytes) ||
    binding.totalBytes < 1 ||
    binding.totalBytes > SEGMENT_V3_STREAM_BYTES ||
    !Number.isInteger(binding.count) ||
    binding.count < 1 ||
    binding.count > SEGMENT_V3_DATA_COUNT ||
    binding.count !== Math.ceil(binding.totalBytes / SEGMENT_V3_PAYLOAD_BYTES) ||
    !Number.isInteger(binding.index) ||
    binding.index < 0 ||
    binding.index >= binding.count
  )
    throw new Error('Segment v3 scope/length/count mismatch');
  const payloadBytes = Math.min(
    SEGMENT_V3_PAYLOAD_BYTES,
    binding.totalBytes - binding.index * SEGMENT_V3_PAYLOAD_BYTES,
  );
  const hashes = [
    segmentV3Hash(Buffer.from(canonicalJson(identity))),
    binding.planHash,
    binding.inventoryHash,
    binding.streamHash,
    binding.runtimeHash,
  ].map((value) => HashSchema.parse(value));
  return { payloadBytes, hashes };
}
/** Only a single segment buffer is accepted; never concatenate a whole stream here. */
export function encodeSegmentV3(payload: Buffer, binding: SegmentV3Binding): Buffer {
  const { payloadBytes, hashes } = checked(binding);
  if (!Buffer.isBuffer(payload) || payload.length !== payloadBytes)
    throw new Error('Segment v3 payload length mismatch');
  const result = Buffer.alloc(SEGMENT_V3_HEADER_BYTES + payload.length);
  magic.copy(result);
  result.writeUInt32BE(3, 8);
  result.writeUInt32BE(binding.runner, 12);
  result.writeUInt32BE(binding.index, 16);
  result.writeUInt32BE(binding.count, 20);
  result.writeUInt32BE(payload.length, 24);
  result.writeBigUInt64BE(BigInt(binding.totalBytes), 32);
  const ordered = [...hashes.slice(0, 4), segmentV3Hash(payload), hashes[4]!];
  ordered.forEach((hash, index) => Buffer.from(hash.slice(7), 'hex').copy(result, 40 + index * 32));
  payload.copy(result, SEGMENT_V3_HEADER_BYTES);
  return result;
}
/** Expected metadata must come from an authenticated index; header claims are not trusted.
 * The caller checks complete unique index coverage and the ordered whole-stream hash.
 */
export function decodeSegmentV3(bytes: Buffer, expected: SegmentV3Expected): Buffer {
  const { payloadBytes, hashes } = checked(expected);
  HashSchema.parse(expected.payloadHash);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== SEGMENT_V3_HEADER_BYTES + payloadBytes ||
    !bytes.subarray(0, 8).equals(magic) ||
    bytes.readUInt32BE(8) !== 3 ||
    bytes.readUInt32BE(12) !== expected.runner ||
    bytes.readUInt32BE(16) !== expected.index ||
    bytes.readUInt32BE(20) !== expected.count ||
    bytes.readUInt32BE(24) !== payloadBytes ||
    bytes.readUInt32BE(28) !== 0 ||
    bytes.readBigUInt64BE(32) !== BigInt(expected.totalBytes) ||
    bytes.subarray(232, 256).some((value) => value !== 0)
  )
    throw new Error('Segment v3 header/length mismatch');
  const ordered = [...hashes.slice(0, 4), expected.payloadHash, hashes[4]!];
  if (
    ordered.some(
      (hash, index) =>
        !bytes.subarray(40 + index * 32, 72 + index * 32).equals(Buffer.from(hash.slice(7), 'hex')),
    )
  )
    throw new Error('Segment v3 binding mismatch');
  const payload = bytes.subarray(SEGMENT_V3_HEADER_BYTES);
  if (segmentV3Hash(payload) !== expected.payloadHash)
    throw new Error('Segment v3 payload checksum mismatch');
  return Buffer.from(payload); // Caller cannot mutate the authenticated input buffer through this result.
}
