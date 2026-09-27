import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parsePackIndex,
  PackEntrySchema,
  PACK_INDEX_BYTES,
  canonicalJson,
  packKey,
  type PackEntry,
} from '@fantasy/domain/spatial';
import { OperationError, operationInput } from '../operation-error.ts';
import { readBoundedFile, sha256 } from './replay-files.ts';

export type PackedEntry = { packHash: string; packBytes: number; entry: PackEntry };
export type ReplayLocation = string | { root: string; entries: PackedEntry[] };
export type ReplayRead = (file: string, limit: number) => Promise<Buffer>;

/** Exact positional read, without following a file or pack-directory symlink. */
export async function readPackEntry(root: string, value: PackedEntry) {
  const entry = operationInput(() => PackEntrySchema.parse(value.entry), 'DATA_INVALID');
  for (const directory of [root, join(root, 'packs')])
    if (!(await lstat(directory)).isDirectory())
      throw new OperationError('DATA_INVALID', 'Invalid pack directory');
  const handle = await open(
    join(root, packKey(value.packHash)),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== value.packBytes || entry.offset + entry.bytes > info.size)
      throw new OperationError('DATA_INVALID', 'Pack size or range mismatch');
    const bytes = Buffer.alloc(entry.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const part = await handle.read(bytes, offset, bytes.length - offset, entry.offset + offset);
      if (!part.bytesRead) throw new OperationError('DATA_INVALID', 'Truncated pack entry');
      offset += part.bytesRead;
    }
    if (sha256(bytes) !== entry.checksum)
      throw new OperationError('DATA_INVALID', 'Pack entry checksum mismatch');
    return bytes;
  } finally {
    await handle.close();
  }
}
export function replayRead(location: ReplayLocation): ReplayRead {
  if (typeof location === 'string')
    return (file, limit) => readBoundedFile(join(location, file), limit);
  return async (file, limit) => {
    const found = location.entries.filter(({ entry }) => entry.key.endsWith('/' + file));
    if (found.length !== 1 || found[0]!.entry.bytes > limit)
      throw new OperationError('DATA_INVALID', 'Missing or oversized packed replay entry');
    return readPackEntry(location.root, found[0]!);
  };
}

/** Content-addressed indexes contain only bounded metadata; payloads are never cached. */
export class PackArchive {
  private loaded: Promise<Map<string, PackedEntry[]>> | undefined;
  constructor(readonly root: string) {}
  async location(objectHash: string) {
    this.loaded ??= this.load();
    const entries = (await this.loaded).get(objectHash);
    if (!entries) throw Object.assign(new Error('Replay is not stored'), { code: 'ENOENT' });
    return { root: this.root, entries };
  }
  private async load() {
    const directory = join(this.root, 'pack-indexes');
    const found = new Map<string, PackedEntry>();
    let bytes = 0;
    try {
      if (!(await lstat(directory)).isDirectory())
        throw new OperationError('DATA_INVALID', 'Invalid pack index directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return new Map<string, PackedEntry[]>();
      throw error;
    }
    for (const name of (await readdir(directory)).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name))
        throw new OperationError('DATA_INVALID', 'Unexpected pack index');
      const data = await readBoundedFile(join(directory, name), PACK_INDEX_BYTES);
      bytes += data.length;
      if (bytes > 64 * 1024 ** 2)
        throw new OperationError('BUDGET_EXCEEDED', 'Pack index memory bound');
      const index = operationInput(() => parsePackIndex(data), 'DATA_INVALID');
      if (sha256(data).slice(7) + '.json' !== name)
        throw new OperationError('DATA_INVALID', 'Pack index checksum mismatch');
      for (const entry of index.entries) {
        const old = found.get(entry.key);
        if (
          old &&
          canonicalJson({ ...old.entry, offset: 0 }) !== canonicalJson({ ...entry, offset: 0 })
        )
          throw new OperationError('DATA_INVALID', 'Conflicting packed replay entry');
        if (!old)
          found.set(entry.key, { packHash: index.packHash, packBytes: index.packBytes, entry });
        if (found.size > 500000)
          throw new OperationError('BUDGET_EXCEEDED', 'Pack entry count bound');
      }
    }
    const objects = new Map<string, PackedEntry[]>();
    for (const value of found.values()) {
      const hash = 'sha256:' + value.entry.key.split('/')[1]!;
      const entries = objects.get(hash) ?? [];
      entries.push(value);
      objects.set(hash, entries);
    }
    return objects;
  }
}
