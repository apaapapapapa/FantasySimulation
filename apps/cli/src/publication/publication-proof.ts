import {
  canonicalJson,
  parsePackIndex,
  assertPackArtifact,
  type PackIndex,
} from '@fantasy/domain/spatial';
import { sha256, OperationError } from '@fantasy/api/artifacts';
import type { PublicationRead, ReplayProof } from './publication-graph.ts';

/** Validate checkpoint storage coverage without treating its hashes as authenticated bytes. */
export function replayProofValidator(read: PublicationRead) {
  const indexes = new Map<string, PackIndex>(),
    used = new Set<string>();
  let bytes = 0;
  const file = (key: string, data: string) => ({
    key,
    bytes: Buffer.byteLength(data),
    checksum: sha256(data),
  });
  const ordered = (values: ReplayProof['logical']) =>
    [...values].sort((a, b) => a.key.localeCompare(b.key));
  const requireEqual = (a: ReplayProof['logical'], b: ReplayProof['logical']) => {
    if (canonicalJson(ordered(a)) !== canonicalJson(ordered(b)))
      throw new OperationError('DATA_INVALID', 'Checkpoint replay storage coverage mismatch');
  };
  return {
    async check(proof: ReplayProof) {
      const prefix = `objects/${proof.ref.objectHash.slice(7)}/`;
      const expected = [
        file(prefix + 'receipt.json', canonicalJson(proof.receipt)),
        file(prefix + 'manifest.json', canonicalJson(proof.manifest)),
        ...[...proof.manifest.chunks, ...proof.manifest.checkpoints].map((ref) => ({
          key: prefix + ref.file,
          bytes: ref.bytes,
          checksum: ref.checksum,
        })),
      ];
      requireEqual(proof.logical, expected);
      if (!('packs' in proof.ref)) {
        requireEqual(proof.physical, expected);
        return;
      }
      const physical = [],
        entries = new Map<string, PackIndex['entries'][number]>();
      for (const ref of proof.ref.packs) {
        const key = `pack-indexes/${ref.hash.slice(7)}.json`;
        let index = indexes.get(ref.hash);
        if (!index) {
          const data = await read(key, ref.bytes);
          bytes += data.length;
          if (bytes > 64 * 1024 ** 2 || data.length !== ref.bytes || sha256(data) !== ref.hash)
            throw new OperationError('DATA_INVALID', 'Checkpoint index size/hash mismatch');
          index = parsePackIndex(data);
          indexes.set(ref.hash, index);
        }
        physical.push(
          { key, bytes: ref.bytes, checksum: ref.hash },
          {
            key: `packs/${index.packHash.slice(7)}.bin`,
            bytes: index.packBytes,
            checksum: index.packHash,
          },
        );
        if (!index.entries.some((entry) => entry.key.startsWith(prefix)))
          throw new OperationError('DATA_INVALID', 'Unrelated checkpoint pack');
        for (const entry of index.entries) {
          if (entries.has(entry.key))
            throw new OperationError('DATA_INVALID', 'Duplicate checkpoint pack entry');
          entries.set(entry.key, entry);
          if (entry.key.startsWith(prefix)) used.add(index.packHash + '/' + entry.key);
        }
      }
      requireEqual(proof.physical, physical);
      const own = [...entries.values()].filter((entry) => entry.key.startsWith(prefix));
      requireEqual(
        own.map(({ key, bytes, checksum }) => ({ key, bytes, checksum })),
        expected,
      );
      for (const ref of [...proof.manifest.chunks, ...proof.manifest.checkpoints])
        assertPackArtifact(entries.get(prefix + ref.file)!, ref);
    },
    finish() {
      for (const index of indexes.values())
        for (const entry of index.entries)
          if (!used.has(index.packHash + '/' + entry.key))
            throw new OperationError('DATA_INVALID', 'Unreferenced checkpoint pack entry');
    },
  };
}
