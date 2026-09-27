import { createHash } from 'node:crypto';
import {
  PACK_GROUP_SLOTS,
  PACK_TARGET_BYTES,
  PACK_RANGE_BYTES,
  PackIndexSchema,
  packKey,
  packIndexKey,
  compareIds,
  type PackEntry,
  type PackIndexRef,
  type PublicMatchRow,
} from '@fantasy/domain/spatial';
import { OperationError } from '@fantasy/api/artifacts';
import { publicationBytes, publicationJson, type PublicationFile } from './publication-files.ts';

/** Original durable bundles are the spool. Keep only descriptors until the bounded commit. */
export async function packPublication(
  files: readonly PublicationFile[],
  rows: PublicMatchRow[],
  signal?: AbortSignal,
) {
  const originals = new Map(files.map((file) => [file.key, file]));
  const byObject = new Map<string, PublicationFile[]>();
  for (const file of originals.values()) {
    const hash = 'sha256:' + file.key.split('/')[1]!;
    const entries = byObject.get(hash) ?? [];
    entries.push(file);
    byObject.set(hash, entries);
  }
  const references = new Map<string, Map<string, PackIndexRef>>();
  const packed = new Map<string, PublicationFile>();
  for (let start = 0; start < rows.length; start += PACK_GROUP_SLOTS) {
    const group = rows.slice(start, start + PACK_GROUP_SLOTS);
    const objects = [
      ...new Set(group.flatMap((row) => (row.replay ? [row.replay.objectHash] : []))),
    ].filter((hash) => !references.has(hash));
    objects.forEach((hash) => references.set(hash, new Map()));
    const entries = objects
      .flatMap((hash) => byObject.get(hash) ?? [])
      .sort((a, b) => compareIds(a.key, b.key));
    let parts: PublicationFile[] = [],
      indexEntries: PackEntry[] = [],
      size = 0,
      hash = createHash('sha256');
    const flush = () => {
      if (!size) return;
      const checksum = 'sha256:' + hash.digest('hex');
      const index = PackIndexSchema.parse({
        schemaVersion: 1,
        packHash: checksum,
        packBytes: size,
        entries: indexEntries,
      });
      const indexFile = publicationJson(packIndexKey('sha256:' + '0'.repeat(64)), index);
      indexFile.key = packIndexKey(indexFile.checksum);
      packed.set(packKey(checksum), { key: packKey(checksum), bytes: size, checksum, parts });
      packed.set(indexFile.key, indexFile);
      for (const entry of indexEntries)
        references
          .get('sha256:' + entry.key.split('/')[1]!)!
          .set(indexFile.checksum, { hash: indexFile.checksum, bytes: indexFile.bytes });
      parts = [];
      indexEntries = [];
      size = 0;
      hash = createHash('sha256');
    };
    for (const file of entries) {
      signal?.throwIfAborted();
      if (file.bytes > PACK_RANGE_BYTES || file.bytes < 1)
        throw new OperationError('BUDGET_EXCEEDED', 'Replay entry exceeds pack range bound');
      if (size && (size + file.bytes > PACK_TARGET_BYTES || parts.length === 16384)) flush();
      const data = await publicationBytes(file);
      indexEntries.push({
        key: file.key,
        offset: size,
        bytes: file.bytes,
        checksum: file.checksum,
        encoding: file.key.endsWith('.gz') ? 'gzip' : 'identity',
        rawBytes: file.rawBytes ?? file.bytes,
      });
      parts.push(file);
      hash.update(data);
      size += file.bytes;
    }
    flush();
  }
  for (const row of rows)
    if (row.replay)
      row.replay = {
        ...row.replay,
        packs: [...references.get(row.replay.objectHash)!.values()].sort((a, b) =>
          compareIds(a.hash, b.hash),
        ),
      };
  return [...packed.values()];
}
