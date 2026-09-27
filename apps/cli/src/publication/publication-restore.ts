import { OperationError } from '@fantasy/api/tooling';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  MAX_PUBLIC_JSON_BYTES,
  PUBLICATION_MAX_FILES,
  PublicKeySchema,
} from '@fantasy/domain/spatial';
import { publicationGraph, localPublicationGraph } from './publication-graph.ts';
import { publicationDirectory, PUBLICATION_MAX_BYTES } from './publication-files.ts';
import { readBoundedFile, writeDurableFile, sha256 } from '@fantasy/api/artifacts';
import type { PublicationStore } from './publication-remote.ts';
import { publicationConcurrency, publicationPool } from './publication-pool.ts';
import { PublicationIo, DEFAULT_TRANSFER_BYTES } from './publication-io.ts';
import type { PublicationRead } from './publication-graph.ts';

/** Recover retained generations on a fresh runner; never mutate R2 or overwrite local files. */
export async function restorePublication(
  directory: string,
  store: Pick<PublicationStore, 'read'>,
  maxDownloadBytes = 256_000_000,
  concurrency = 1,
  maxInFlightBytes = DEFAULT_TRANSFER_BYTES,
  signal?: AbortSignal,
) {
  publicationConcurrency(concurrency, 64);
  signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(maxDownloadBytes) ||
    maxDownloadBytes < 1 ||
    maxDownloadBytes > PUBLICATION_MAX_BYTES
  )
    throw new OperationError('INPUT_INVALID', 'Invalid publication restore budget');
  const io = new PublicationIo(concurrency, maxInFlightBytes, signal);
  const root = resolve(directory);
  let owned = false;
  try {
    await publicationDirectory(dirname(root), true);
    await mkdir(root); // Never remove an existing directory/file/symlink.
    owned = true;
    let downloadBytes = 0,
      reservedBytes = 0,
      reads = 0;
    const remote = async (key: string, limit: number) => {
      const remaining = maxDownloadBytes - downloadBytes - reservedBytes;
      if (remaining < 1)
        throw new OperationError('BUDGET_EXCEEDED', 'Publication restore byte limit');
      const allowed = Math.min(limit, remaining);
      reservedBytes += allowed;
      reads++;
      try {
        const value = await store.read(key, allowed);
        if (value) {
          if (value.data.length > allowed)
            throw new OperationError('BUDGET_EXCEEDED', 'Publication restore byte limit');
          downloadBytes += value.data.length;
        }
        return value;
      } finally {
        reservedBytes -= allowed;
      }
    };
    const pointer = 'catalog/current.json';
    const before = await remote(pointer, MAX_PUBLIC_JSON_BYTES);
    if (!before) {
      if (await remote(pointer, MAX_PUBLIC_JSON_BYTES))
        throw new OperationError(
          'PUBLICATION_CONFLICT',
          'Publication generation changed during restore',
        );
      return { status: 'empty' as const, files: 0, downloadBytes, reads };
    }
    const downloaded = new Set<string>();
    const pending = new Map<string, Promise<void>>();
    const download = async (key: string, limit: number, checksum?: string) => {
      PublicKeySchema.parse(key);
      const path = join(root, key);
      if (!downloaded.has(key)) {
        let task = pending.get(key);
        if (!task) {
          if (downloaded.size + pending.size >= PUBLICATION_MAX_FILES)
            throw new OperationError('BUDGET_EXCEEDED', 'Publication restore file limit');
          task = io.run(limit, async () => {
            const value = key === pointer ? before : await remote(key, limit);
            if (
              !value ||
              value.data.length > limit ||
              (checksum && (value.data.length !== limit || sha256(value.data) !== checksum))
            )
              throw new OperationError(
                'DATA_INVALID',
                'Retained publication is missing or corrupt',
              );
            await publicationDirectory(dirname(path), true);
            await writeDurableFile(path, value.data);
            downloaded.add(key);
          });
          pending.set(key, task);
        }
        try {
          await task;
        } finally {
          if (pending.get(key) === task) pending.delete(key);
        }
      }
      return io.run(limit, async () => {
        const bytes = await readBoundedFile(path, limit);
        if (checksum && (bytes.length !== limit || sha256(bytes) !== checksum))
          throw new OperationError('DATA_INVALID', 'Retained publication reference changed');
        return bytes;
      });
    };
    const source: PublicationRead = (key, limit) => download(key, limit);
    source.prefetch = async (files) => {
      await publicationPool(
        files,
        concurrency,
        async (file) => {
          await download(file.key, file.bytes, file.checksum);
        },
        'restore.prefetch',
        64,
      );
    };
    const graph = await publicationGraph(source, concurrency);
    // Reuse bundle verification and expanded-gzip privacy checks, not just remote checksums.
    await localPublicationGraph(root, 1, signal);
    signal?.throwIfAborted();
    const after = await remote(pointer, MAX_PUBLIC_JSON_BYTES);
    if (!after || after.etag !== before.etag || !after.data.equals(before.data))
      throw new OperationError(
        'PUBLICATION_CONFLICT',
        'Publication generation changed during restore',
      );
    return {
      status: 'restored' as const,
      catalogHash: graph.current.catalogHash,
      files: graph.files.size,
      downloadBytes,
      reads,
    };
  } catch (error) {
    await io.close(error);
    if (owned) await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    await io.close();
  }
}
