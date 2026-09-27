import {
  assertPublicPageBinding,
  parsePackIndex,
  packKey,
  packIndexKey,
  assertPackArtifact,
  assertPackedFiles,
  assertPackResponse,
  type PackRange,
  type PackIndex,
  assertPublicReplayBinding,
  BundleReceiptSchema,
  canonicalJson,
  contentHash,
  hashBytes,
  MAX_PUBLIC_JSON_BYTES,
  MAX_REPLAY_MANIFEST_BYTES,
  PublicCatalogCurrentSchema,
  PublicCatalogSchema,
  PublicKeySchema,
  PublicMatchPageSchema,
  PublicReplaySetSchema,
  publicHashName,
  type ArtifactRef,
  type PublicCatalog,
  type PublicMatchRow,
  type PublicReplaySet,
} from '@fantasy/domain/spatial';
import { readBounded, ReplayLoadError, strictText, toLoadError } from './artifacts.ts';
import { parseSavedManifest, type ReplaySource } from './open-replay.ts';

export interface PublicReadObservation {
  requestId: number;
  key: string;
  event: 'request' | 'response' | 'failed';
  elapsedMs: number;
  decodedBytes?: number;
}

/** A configured public data origin only. This adapter has no local API fallback. */
export function publicLibrary(
  root: string,
  request: typeof fetch = fetch,
  observe?: (value: PublicReadObservation) => void,
) {
  const base = new URL(root);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new ReplayLoadError('unavailable', 'Invalid public data URL');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  let sequence = 0;
  async function bytes(
    key: string,
    limit: number,
    signal?: AbortSignal,
    expected?: { checksum: string; bytes?: number },
    range?: PackRange,
  ) {
    let requestId = 0;
    const startedAt = performance.now();
    const report = (event: PublicReadObservation['event'], decodedBytes?: number) => {
      if (!requestId || !observe) return;
      try {
        observe({
          requestId,
          key,
          event,
          elapsedMs: performance.now() - startedAt,
          ...(decodedBytes === undefined ? {} : { decodedBytes }),
        });
      } catch {
        // Optional observation must never change loading, validation or cancellation.
      }
    };
    try {
      signal?.throwIfAborted();
      const url = new URL(PublicKeySchema.parse(key), base);
      requestId = ++sequence;
      report('request');
      const response = await request(url, {
        signal: signal ?? null,
        credentials: 'omit',
        redirect: 'error',
        headers: {
          accept: range
            ? 'application/octet-stream'
            : key.endsWith('.gz')
              ? 'application/gzip'
              : 'application/json',
          ...(range ? { Range: `bytes=${range.offset}-${range.offset + range.bytes - 1}` } : {}),
        },
      });
      const type = range
        ? 'application/octet-stream'
        : key.endsWith('.gz')
          ? 'application/gzip'
          : 'application/json';
      if (!response.ok) {
        // Cloudflare's platform limit may occur before the Worker runs. If CORS hides it,
        // fetch rejects and it remains an unavailable response rather than a guessed 1027.
        const errorBody = await readBounded(
          response.body ?? new Blob().stream(),
          16384,
          'Delivery error',
        ).catch(() => new Uint8Array());
        const limit =
          response.status === 429 ||
          /\b(?:error\s*:?\s*1027|Error code:\s*1027)\b/i.test(new TextDecoder().decode(errorBody));
        throw new ReplayLoadError(
          limit ? 'limit' : response.status === 404 ? 'gone' : 'unavailable',
          `Public data response ${response.status}: ${key}`,
        );
      }
      if (range) {
        try {
          assertPackResponse(response.status, response.headers, range);
        } catch (error) {
          await response.body?.cancel();
          throw toLoadError(error, 'damaged', signal);
        }
      }
      if (
        !(response.headers.get('content-type') ?? '').startsWith(type) ||
        (key.endsWith('.gz') && response.headers.has('content-encoding'))
      ) {
        await response.body?.cancel();
        throw new ReplayLoadError('damaged', `Public data response ${response.status}: ${key}`);
      }
      const value = await readBounded(response.body ?? new Blob().stream(), limit, key);
      report('response', value.byteLength);
      signal?.throwIfAborted();
      if (
        expected &&
        ((expected.bytes !== undefined && value.byteLength !== expected.bytes) ||
          (await hashBytes(value)) !== expected.checksum)
      )
        throw new ReplayLoadError('damaged', `Public data checksum/size mismatch: ${key}`);
      return value;
    } catch (error) {
      report('failed');
      throw toLoadError(error, 'unavailable', signal);
    }
  }
  async function json<T>(
    key: string,
    schema: { parse(value: unknown): T },
    signal?: AbortSignal,
    expected?: { checksum: string; bytes?: number },
  ) {
    try {
      const raw = await bytes(key, expected?.bytes ?? MAX_PUBLIC_JSON_BYTES, signal, expected);
      return schema.parse(JSON.parse(strictText(raw, key)));
    } catch (error) {
      throw toLoadError(error, 'damaged', signal);
    }
  }
  async function catalog(signal?: AbortSignal) {
    const current = await json('catalog/current.json', PublicCatalogCurrentSchema, signal);
    const catalog = await json(
      `catalog/${publicHashName(current.catalogHash)}.json`,
      PublicCatalogSchema,
      signal,
      { checksum: current.catalogHash, bytes: current.bytes },
    );
    if (catalog.schemaVersion !== current.schemaVersion)
      throw new ReplayLoadError('damaged', 'Public catalog version mismatch');
    return catalog;
  }
  async function set(ref: PublicCatalog['sets'][number], signal?: AbortSignal) {
    return json(`sets/${publicHashName(ref.setHash)}/set.json`, PublicReplaySetSchema, signal, {
      checksum: ref.setHash,
      bytes: ref.bytes,
    });
  }
  async function page(setHash: string, set: PublicReplaySet, index: number, signal?: AbortSignal) {
    const ref = set.pages[index];
    if (!ref) throw new ReplayLoadError('damaged', 'Public page is outside the set');
    const value = await json(
      `sets/${publicHashName(setHash)}/${publicHashName(ref.pageHash)}.json`,
      PublicMatchPageSchema,
      signal,
      { checksum: ref.pageHash, bytes: ref.bytes },
    );
    assertPublicPageBinding(set, value);
    if (value.index !== index) throw new ReplayLoadError('damaged', 'Public page index mismatch');
    return value;
  }
  function source(row: PublicMatchRow): ReplaySource {
    const ref = row.replay;
    if (!ref) throw new ReplayLoadError('damaged', 'This match has no published replay');
    const prefix = `objects/${publicHashName(ref.objectHash)}/`;
    let allowed: readonly ArtifactRef[] = [];
    let indexes: PackIndex[] | undefined;
    const read = async (
      name: string,
      limit: number,
      signal?: AbortSignal,
      expected?: { bytes?: number; checksum: string; rawBytes?: number },
    ) => {
      if (!('packs' in ref)) return bytes(prefix + name, limit, signal, expected);
      if (!indexes) {
        const loaded: PackIndex[] = [];
        for (const indexRef of ref.packs) {
          const index = parsePackIndex(
            await bytes(packIndexKey(indexRef.hash), indexRef.bytes, signal, {
              checksum: indexRef.hash,
              bytes: indexRef.bytes,
            }),
          );
          if (!index.entries.some((entry) => entry.key.startsWith(prefix)))
            throw new ReplayLoadError('damaged', 'Unrelated pack index');
          loaded.push(index);
        }
        const keys = loaded.flatMap((index) => index.entries.map((entry) => entry.key));
        if (new Set(keys).size !== keys.length)
          throw new ReplayLoadError('damaged', 'Duplicate packed replay entry');
        indexes = loaded;
      }
      const found = indexes.flatMap((index) =>
        index.entries
          .filter((entry) => entry.key === prefix + name)
          .map((entry) => ({ index, entry })),
      );
      if (found.length !== 1) throw new ReplayLoadError('damaged', 'Missing packed replay entry');
      const { index, entry } = found[0]!;
      if (entry.bytes > limit)
        throw new ReplayLoadError('damaged', 'Packed replay entry exceeds its bound');
      if (expected)
        assertPackArtifact(entry, { ...expected, bytes: expected.bytes ?? entry.bytes });
      return bytes(packKey(index.packHash), entry.bytes, signal, entry, {
        offset: entry.offset,
        bytes: entry.bytes,
        total: index.packBytes,
      });
    };
    return {
      ...(request === fetch ? { location: { mode: 'public' as const, root: base.href, row } } : {}),
      async manifest(signal) {
        const receipt = BundleReceiptSchema.parse(
          JSON.parse(
            strictText(
              await read('receipt.json', ref.receiptBytes, signal, {
                checksum: ref.receiptChecksum,
                bytes: ref.receiptBytes,
              }),
              'Public receipt',
            ),
          ),
        );
        const { objectHash, ...body } = receipt;
        if (objectHash !== ref.objectHash || (await contentHash(body)) !== objectHash)
          throw new ReplayLoadError('damaged', 'Public receipt identity mismatch');
        // The manifest byte size is not a public reference field; it is bounded before hashing.
        const raw = await read('manifest.json', MAX_REPLAY_MANIFEST_BYTES, signal);
        if ((await hashBytes(raw)) !== ref.manifestChecksum)
          throw new ReplayLoadError('damaged', 'Public manifest checksum mismatch');
        const value: unknown = JSON.parse(strictText(raw, 'Public manifest'));
        const manifest = parseSavedManifest(value);
        assertPublicReplayBinding(row, receipt, manifest);
        allowed = [...manifest.chunks, ...manifest.checkpoints];
        if (indexes)
          assertPackedFiles(
            indexes
              .flatMap((index) => index.entries)
              .filter((entry) => entry.key.startsWith(prefix)),
            [
              {
                key: prefix + 'receipt.json',
                bytes: ref.receiptBytes,
                checksum: ref.receiptChecksum,
              },
              {
                key: prefix + 'manifest.json',
                bytes: raw.byteLength,
                checksum: ref.manifestChecksum,
              },
              ...allowed.map((artifact) => ({ ...artifact, key: prefix + artifact.file })),
            ],
          );
        return manifest;
      },
      async file(artifact, signal) {
        if (!allowed.some((ref) => canonicalJson(ref) === canonicalJson(artifact)))
          throw new ReplayLoadError('damaged', 'Artifact is not in the verified manifest');
        return read(artifact.file, artifact.bytes, signal, artifact);
      },
    };
  }
  function leagueDocument<T>(
    ref: { hash: string; bytes?: number },
    schema: { parse(value: unknown): T },
    signal?: AbortSignal,
  ) {
    return json(`leagues/${publicHashName(ref.hash)}.json`, schema, signal, {
      checksum: ref.hash,
      ...(ref.bytes === undefined ? {} : { bytes: ref.bytes }),
    });
  }
  return { catalog, set, page, source, leagueDocument };
}
export type PublicLibrary = ReturnType<typeof publicLibrary>;
