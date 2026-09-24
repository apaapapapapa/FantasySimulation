import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MAX_PUBLIC_JSON_BYTES, PublicKeySchema } from '@fantasy/domain/spatial';
import { publicationGraph, localPublicationGraph } from './publication-graph.ts';
import { publicationDirectory, PUBLICATION_MAX_BYTES } from './publication-files.ts';
import { readBoundedFile, writeDurableFile } from './replay-files.ts';
import type { PublicationStore } from './publication-remote.ts';

/** Recover retained generations on a fresh runner; never mutate R2 or overwrite local files. */
export async function restorePublication(
  directory: string,
  store: Pick<PublicationStore, 'read'>,
  maxDownloadBytes = 256_000_000,
) {
  if (
    !Number.isSafeInteger(maxDownloadBytes) ||
    maxDownloadBytes < 1 ||
    maxDownloadBytes > PUBLICATION_MAX_BYTES
  )
    throw new Error('Invalid publication restore budget');
  const root = resolve(directory);
  await publicationDirectory(dirname(root), true);
  await mkdir(root); // Exclusive ownership: an existing directory/file/symlink is never removed.
  try {
    let downloadBytes = 0,
      reads = 0;
    const remote = async (key: string, limit: number) => {
      const remaining = maxDownloadBytes - downloadBytes;
      if (remaining < 1) throw new Error('Publication restore byte limit');
      const allowed = Math.min(limit, remaining);
      reads++;
      const value = await store.read(key, allowed);
      if (value) {
        if (value.data.length > allowed) throw new Error('Publication restore byte limit');
        downloadBytes += value.data.length;
      }
      return value;
    };
    const pointer = 'catalog/current.json';
    const before = await remote(pointer, MAX_PUBLIC_JSON_BYTES);
    if (!before) {
      if (await remote(pointer, MAX_PUBLIC_JSON_BYTES))
        throw new Error('Publication generation changed during restore');
      return { status: 'empty' as const, files: 0, downloadBytes, reads };
    }
    const downloaded = new Set<string>();
    const graph = await publicationGraph(async (key, limit) => {
      const path = join(root, PublicKeySchema.parse(key));
      if (downloaded.has(key)) return readBoundedFile(path, limit);
      const value = key === pointer ? before : await remote(key, limit);
      if (!value || value.data.length > limit)
        throw new Error('Retained publication is missing or oversized');
      await publicationDirectory(dirname(path), true);
      await writeDurableFile(path, value.data);
      downloaded.add(key);
      return value.data;
    });
    // Reuse bundle verification and expanded-gzip privacy checks, not just remote checksums.
    await localPublicationGraph(root);
    const after = await remote(pointer, MAX_PUBLIC_JSON_BYTES);
    if (!after || after.etag !== before.etag || !after.data.equals(before.data))
      throw new Error('Publication generation changed during restore');
    return {
      status: 'restored' as const,
      catalogHash: graph.current.catalogHash,
      files: graph.files.size,
      downloadBytes,
      reads,
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
