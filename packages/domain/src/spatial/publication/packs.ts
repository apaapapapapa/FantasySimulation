import { z } from 'zod';
import { canonicalJson } from '../canonical.ts';
import { HashSchema, MAX_FRAME_BYTES } from '../contracts.ts';

export class PackValidationError extends Error {}

export const PACK_GROUP_SLOTS = 64;
export const PACK_TARGET_BYTES = 16 * 1024 ** 2;
export const PACK_MAX_BYTES = 32 * 1024 ** 2;
export const PACK_RANGE_BYTES = 16 * 1024 ** 2;
export const PACK_INDEX_BYTES = 4_000_000;
export const ReplayObjectKeySchema = z
  .string()
  .regex(
    /^objects\/[0-9a-f]{64}\/(?:receipt\.json|manifest\.json|chunk-[0-9]{5}\.ndjson\.gz|checkpoint-[0-9]{5}\.json\.gz)$/,
  );
export const PackIndexRefSchema = z.strictObject({
  hash: HashSchema,
  bytes: z.number().int().min(1).max(PACK_INDEX_BYTES),
});
export const PackedReplayRefsSchema = z
  .array(PackIndexRefSchema)
  .min(1)
  .max(16)
  .superRefine((refs, ctx) => {
    if (refs.some((ref, i) => i > 0 && refs[i - 1]!.hash >= ref.hash))
      ctx.addIssue({ code: 'custom', message: 'Pack references must be unique and sorted' });
  });
export const PackEntrySchema = z
  .strictObject({
    key: ReplayObjectKeySchema,
    offset: z
      .number()
      .int()
      .min(0)
      .max(PACK_MAX_BYTES - 1),
    bytes: z.number().int().min(1).max(PACK_RANGE_BYTES),
    checksum: HashSchema,
    encoding: z.enum(['identity', 'gzip']),
    rawBytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_FRAME_BYTES + 1),
  })
  .superRefine((entry, ctx) => {
    if (
      entry.offset + entry.bytes > PACK_MAX_BYTES ||
      entry.encoding !== (entry.key.endsWith('.gz') ? 'gzip' : 'identity') ||
      (entry.encoding === 'identity' &&
        (entry.rawBytes !== entry.bytes ||
          entry.bytes > (entry.key.endsWith('/receipt.json') ? 65536 : PACK_INDEX_BYTES)))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid pack entry bounds or encoding' });
  });
export const PackIndexSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    packHash: HashSchema,
    packBytes: z.number().int().min(1).max(PACK_MAX_BYTES),
    entries: z.array(PackEntrySchema).min(1).max(16384),
  })
  .superRefine((index, ctx) => {
    let offset = 0;
    for (const [i, entry] of index.entries.entries()) {
      if (entry.offset !== offset || (i > 0 && index.entries[i - 1]!.key >= entry.key)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Pack entries must cover the pack once in key order',
        });
        return;
      }
      offset += entry.bytes;
    }
    if (offset !== index.packBytes)
      ctx.addIssue({ code: 'custom', message: 'Pack size does not match its entries' });
  });
export type PackIndex = z.infer<typeof PackIndexSchema>;
export type PackEntry = z.infer<typeof PackEntrySchema>;
export type PackIndexRef = z.infer<typeof PackIndexRefSchema>;
export type PackRange = { offset: number; bytes: number; total: number };
export const packKey = (hash: string) => `packs/${HashSchema.parse(hash).slice(7)}.bin`;
export const packIndexKey = (hash: string) =>
  `pack-indexes/${HashSchema.parse(hash).slice(7)}.json`;

/** A closed, single range only; perform this check before accessing storage. */
export function parsePackRange(value: string | null) {
  const match = value?.match(/^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/);
  if (!match) return null;
  const offset = Number(match[1]),
    end = Number(match[2]);
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(end) ||
    offset < 0 ||
    end < offset ||
    end >= PACK_MAX_BYTES ||
    end - offset + 1 > PACK_RANGE_BYTES
  )
    return null;
  return { offset, bytes: end - offset + 1 };
}
export function packContentRange(range: PackRange) {
  return `bytes ${range.offset}-${range.offset + range.bytes - 1}/${range.total}`;
}
/** Shared by browser and publication read-back; never accept a full-object fallback. */
export function assertPackResponse(
  status: number,
  headers: Pick<Headers, 'get'>,
  range: PackRange,
) {
  if (
    status !== 206 ||
    headers.get('content-range') !== packContentRange(range) ||
    headers.get('content-length') !== String(range.bytes) ||
    headers.get('accept-ranges') !== 'bytes' ||
    !headers.get('etag') ||
    headers.get('content-encoding') !== null
  )
    throw new PackValidationError('Invalid pack range response');
}
export function assertPackArtifact(
  entry: PackEntry,
  artifact: { bytes: number; checksum: string; rawBytes?: number },
) {
  if (
    entry.bytes !== artifact.bytes ||
    entry.checksum !== artifact.checksum ||
    (artifact.rawBytes !== undefined && entry.rawBytes !== artifact.rawBytes)
  )
    throw new PackValidationError('Pack entry does not match the original replay');
}

export function assertPackedFiles(
  entries: readonly PackEntry[],
  expected: readonly { key: string; bytes: number; checksum: string; rawBytes?: number }[],
) {
  if (entries.length !== expected.length)
    throw new PackValidationError('Packed replay file coverage mismatch');
  const byKey = new Map<string, PackEntry>();
  for (const entry of entries) {
    if (byKey.has(entry.key))
      throw new PackValidationError('Missing or duplicate packed replay file');
    byKey.set(entry.key, entry);
  }
  for (const file of expected) {
    const entry = byKey.get(file.key);
    if (!entry) throw new PackValidationError('Missing or duplicate packed replay file');
    assertPackArtifact(entry, file);
    byKey.delete(file.key);
  }
}

export function parsePackIndex(bytes: Uint8Array): PackIndex {
  if (bytes.byteLength > PACK_INDEX_BYTES) throw new PackValidationError('Pack index byte bound');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const index = PackIndexSchema.parse(JSON.parse(text));
  if (canonicalJson(index) !== text) throw new PackValidationError('Pack index must be canonical');
  return index;
}
