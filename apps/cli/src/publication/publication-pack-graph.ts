import {
  parsePackIndex,
  packKey,
  packIndexKey,
  assertPackArtifact,
  type PackIndex,
  type PublicReplayRef,
} from '@fantasy/domain/spatial';
import { OperationError, sha256 } from '@fantasy/api/artifacts';
import { receiptIdentity, type PublicationFile } from './publication-files.ts';

/** One pack payload retained at a time. Callers serialize packed rows, including failures. */
export function packGraphReader(
  read: (key: string, limit: number) => Promise<Buffer>,
  add: (file: PublicationFile) => void,
  results: Map<string, string>,
) {
  const indexes = new Map<string, PackIndex>();
  const indexSizes = new Map<string, number>();
  const used = new Set<string>();
  const verified = new WeakSet<PackIndex>();
  let cached: { key: string; data: Buffer } | undefined;
  let metadataBytes = 0;
  async function load(index: PackIndex) {
    const key = packKey(index.packHash);
    if (cached?.key !== key) {
      cached = undefined;
      const data = await read(key, index.packBytes);
      if (data.length !== index.packBytes || sha256(data) !== index.packHash)
        throw new OperationError('DATA_INVALID', 'Pack checksum or size mismatch');
      cached = { key, data };
    }
    if (!verified.has(index)) {
      for (const entry of index.entries) {
        const data = cached.data.subarray(entry.offset, entry.offset + entry.bytes);
        if (sha256(data) !== entry.checksum)
          throw new OperationError('DATA_INVALID', 'Pack entry checksum mismatch');
        if (entry.key.endsWith('/receipt.json')) receiptIdentity(entry.key, data, results);
      }
      verified.add(index);
    }
    add({ key, bytes: index.packBytes, checksum: index.packHash });
    return cached.data;
  }
  async function source(ref: PublicReplayRef) {
    if (!('packs' in ref)) return null;
    const prefix = `objects/${ref.objectHash.slice(7)}/`;
    const locations = new Map<string, { index: PackIndex; entry: PackIndex['entries'][number] }>();
    for (const indexRef of ref.packs) {
      let index = indexes.get(indexRef.hash);
      if (!index) {
        const key = packIndexKey(indexRef.hash),
          data = await read(key, indexRef.bytes);
        if (data.length !== indexRef.bytes || sha256(data) !== indexRef.hash)
          throw new OperationError('DATA_INVALID', 'Pack index checksum mismatch');
        index = parsePackIndex(data);
        metadataBytes += data.length;
        if (metadataBytes > 64 * 1024 ** 2)
          throw new OperationError('BUDGET_EXCEEDED', 'Pack index memory bound');
        add({ key, bytes: data.length, checksum: indexRef.hash });
        indexes.set(indexRef.hash, index);
        indexSizes.set(indexRef.hash, data.length);
      } else if (indexSizes.get(indexRef.hash) !== indexRef.bytes)
        throw new OperationError('DATA_INVALID', 'Pack index reference size mismatch');
      if (!index.entries.some((entry) => entry.key.startsWith(prefix)))
        throw new OperationError('DATA_INVALID', 'Unrelated pack index');
      for (const entry of index.entries) {
        if (locations.has(entry.key))
          throw new OperationError('DATA_INVALID', 'Duplicate packed entry');
        locations.set(entry.key, { index, entry });
      }
    }
    return {
      async read(
        key: string,
        limit: number,
        expected?: { bytes: number; checksum: string; rawBytes?: number },
      ) {
        const location = locations.get(key);
        if (!location || !key.startsWith(prefix) || location.entry.bytes > limit)
          throw new OperationError('DATA_INVALID', 'Missing or oversized pack entry');
        if (expected) assertPackArtifact(location.entry, expected);
        const data = await load(location.index);
        used.add(location.index.packHash + '/' + key);
        return Buffer.from(
          data.subarray(location.entry.offset, location.entry.offset + location.entry.bytes),
        );
      },
    };
  }
  return {
    source,
    finish() {
      for (const index of indexes.values())
        for (const entry of index.entries)
          if (!used.has(index.packHash + '/' + entry.key))
            throw new OperationError('DATA_INVALID', 'Unreferenced pack entry');
      cached = undefined;
    },
  };
}
