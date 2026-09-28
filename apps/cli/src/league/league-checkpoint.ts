import { gzipSync, gunzipSync } from 'node:zlib';
import {
  canonicalJson,
  LeagueCheckpointLocatorSchema,
  LeagueEvidenceCheckpointSchema,
} from '@fantasy/domain/spatial';
import { OperationError, sha256 } from '@fantasy/api/artifacts';
import type { PublicationStore } from '../publication/publication-remote.ts';

export const checkpointArchiveKey = (hash: string) =>
  `control/league-checkpoints/${hash.slice(7)}.zip`;
export const checkpointLocatorKey = (hash: string) =>
  `control/league-checkpoints/${hash.slice(7)}.json`;
export const CHECKPOINT_RESERVE_BYTES = 64 * 1024 ** 2 + 65536;

export function encodeLeagueCheckpoint(input: unknown) {
  const checkpoint = LeagueEvidenceCheckpointSchema.parse(input);
  const bytes = Buffer.from(canonicalJson(checkpoint));
  if (bytes.length > 128 * 1024 ** 2)
    throw new OperationError('BUDGET_EXCEEDED', 'Checkpoint metadata size bound');
  const compressed = gzipSync(bytes);
  if (compressed.length > 60 * 1024 ** 2)
    throw new OperationError('BUDGET_EXCEEDED', 'Checkpoint archive size bound');
  return compressed;
}
export function decodeLeagueCheckpoint(compressed: Buffer) {
  if (compressed.length > 60 * 1024 ** 2)
    throw new OperationError('BUDGET_EXCEEDED', 'Checkpoint archive size bound');
  return LeagueEvidenceCheckpointSchema.parse(
    JSON.parse(gunzipSync(compressed, { maxOutputLength: 128 * 1024 ** 2 }).toString('utf8')),
  );
}
/** Persist the exact authenticated ZIP; the catalog locator is replaceable after a failed writer. */
export async function persistLeagueCheckpoint(
  store: PublicationStore,
  input: unknown,
  archive: Buffer,
) {
  const locator = LeagueCheckpointLocatorSchema.parse(input);
  if (archive.length !== locator.archiveBytes || sha256(archive) !== locator.archiveHash)
    throw new OperationError('DATA_INVALID', 'Checkpoint actual ZIP digest mismatch');
  const inventory = await store.inventory();
  const archiveKey = checkpointArchiveKey(locator.archiveHash),
    locatorKey = checkpointLocatorKey(locator.catalogHash);
  const bytes = Buffer.from(canonicalJson(locator));
  if (
    [...inventory.values()].reduce((a, b) => a + b, 0) +
      (inventory.has(archiveKey) ? 0 : archive.length) +
      bytes.length >
      8000000000 ||
    inventory.size + (inventory.has(archiveKey) ? 0 : 1) + (inventory.has(locatorKey) ? 0 : 1) >
      500000
  )
    throw new OperationError('BUDGET_EXCEEDED', 'Checkpoint retained capacity');
  for (const [key, payload, replace] of [
    [archiveKey, archive, false],
    [locatorKey, bytes, true],
  ] as const) {
    const before = await store.read(key, replace ? 65536 : 64 * 1024 ** 2);
    if (before?.data.equals(payload)) continue;
    if (before && !replace)
      throw new OperationError('DATA_INVALID', 'Checkpoint immutable ZIP collision');
    try {
      await store.put(key, payload, before?.etag ?? null);
    } catch (error) {
      const after = await store.read(key, payload.length);
      if (!after?.data.equals(payload)) throw error;
    }
    const saved = await store.read(key, payload.length);
    if (!saved?.data.equals(payload))
      throw new OperationError('DATA_INVALID', 'Checkpoint durable readback failed');
  }
  return locator;
}
