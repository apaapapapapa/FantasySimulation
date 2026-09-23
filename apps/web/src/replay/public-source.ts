import {
  assertPublicPageBinding,
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

/** A configured public data origin only. This adapter has no local API fallback. */
export function publicLibrary(root: string, request: typeof fetch = fetch) {
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
  async function bytes(
    key: string,
    limit: number,
    signal?: AbortSignal,
    expected?: { checksum: string; bytes: number },
  ) {
    try {
      signal?.throwIfAborted();
      const url = new URL(PublicKeySchema.parse(key), base);
      const response = await request(url, {
        signal: signal ?? null,
        credentials: 'omit',
        redirect: 'error',
        headers: { accept: key.endsWith('.gz') ? 'application/gzip' : 'application/json' },
      });
      const type = key.endsWith('.gz') ? 'application/gzip' : 'application/json';
      if (
        !response.ok ||
        !(response.headers.get('content-type') ?? '').startsWith(type) ||
        (key.endsWith('.gz') && response.headers.has('content-encoding'))
      ) {
        await response.body?.cancel();
        throw new ReplayLoadError(
          response.status === 404 ? 'damaged' : 'unavailable',
          `Public data response ${response.status}: ${key}`,
        );
      }
      const value = await readBounded(response.body ?? new Blob().stream(), limit, key);
      signal?.throwIfAborted();
      if (
        expected &&
        (value.byteLength !== expected.bytes || (await hashBytes(value)) !== expected.checksum)
      )
        throw new ReplayLoadError('damaged', `Public data checksum/size mismatch: ${key}`);
      return value;
    } catch (error) {
      throw toLoadError(error, 'unavailable', signal);
    }
  }
  async function json<T>(
    key: string,
    schema: { parse(value: unknown): T },
    signal?: AbortSignal,
    expected?: { checksum: string; bytes: number },
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
    return json(
      `catalog/${publicHashName(current.catalogHash)}.json`,
      PublicCatalogSchema,
      signal,
      { checksum: current.catalogHash, bytes: current.bytes },
    );
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
    return {
      async manifest(signal) {
        const receipt = await json(`${prefix}receipt.json`, BundleReceiptSchema, signal, {
          checksum: ref.receiptChecksum,
          bytes: ref.receiptBytes,
        });
        const { objectHash, ...body } = receipt;
        if (objectHash !== ref.objectHash || (await contentHash(body)) !== objectHash)
          throw new ReplayLoadError('damaged', 'Public receipt identity mismatch');
        // The manifest byte size is not a public reference field; it is bounded before hashing.
        const raw = await bytes(`${prefix}manifest.json`, MAX_REPLAY_MANIFEST_BYTES, signal);
        if ((await hashBytes(raw)) !== ref.manifestChecksum)
          throw new ReplayLoadError('damaged', 'Public manifest checksum mismatch');
        const value: unknown = JSON.parse(strictText(raw, 'Public manifest'));
        const manifest = parseSavedManifest(value);
        assertPublicReplayBinding(row, receipt, manifest);
        allowed = [...manifest.chunks, ...manifest.checkpoints];
        return manifest;
      },
      async file(artifact, signal) {
        if (!allowed.some((ref) => canonicalJson(ref) === canonicalJson(artifact)))
          throw new ReplayLoadError('damaged', 'Artifact is not in the verified manifest');
        return bytes(prefix + artifact.file, artifact.bytes, signal, artifact);
      },
    };
  }
  return { catalog, set, page, source };
}
