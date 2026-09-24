import { dirname, join } from 'node:path';
import {
  PublicCatalogCurrentSchema,
  PublicCatalogSchema,
  PublicReplaySetSchema,
  PublicMatchPageSchema,
  ReplayManifestSchema,
  MAX_PUBLIC_JSON_BYTES,
  MAX_REPLAY_MANIFEST_BYTES,
  assertPublicPageBinding,
  assertPublicReplayBinding,
  canonicalJson,
  publicHashName,
  type PublicReplaySet,
} from '@fantasy/domain/spatial';
import { BattleBundles } from './battle-bundle.ts';
import { readBoundedFile, sha256 } from './replay-files.ts';
import {
  assertPublicData,
  inspectPublicArtifact,
  publicationDirectory,
  PUBLICATION_MAX_BYTES,
  PUBLICATION_MAX_FILES,
  receiptIdentity,
  type PublicationFile,
} from './publication-files.ts';

export type PublicationRead = (key: string, limit: number) => Promise<Buffer>;

/** Traverse all retained generations, validating content-addressed references before any mutation. */
export async function publicationGraph(source: PublicationRead) {
  const files = new Map<string, PublicationFile>(),
    sources = new Set<string>();
  const results = new Map<string, string>(),
    objects = new Set<string>(),
    sets = new Map<string, PublicReplaySet>();
  let totalBytes = 0,
    reads = 0,
    readBytes = 0;
  const read: PublicationRead = async (key, limit) => {
    if (++reads > PUBLICATION_MAX_FILES) throw new Error('Publication graph read limit');
    const bytes = await source(key, limit);
    readBytes += bytes.length;
    if (bytes.length > limit || readBytes > PUBLICATION_MAX_BYTES)
      throw new Error('Publication graph byte limit');
    return bytes;
  };
  function add(file: PublicationFile) {
    const old = files.get(file.key);
    if (old && (old.checksum !== file.checksum || old.bytes !== file.bytes))
      throw new Error('Conflicting public reference');
    if (!old) {
      files.set(file.key, file);
      totalBytes += file.bytes;
    }
    if (files.size > PUBLICATION_MAX_FILES || totalBytes > PUBLICATION_MAX_BYTES)
      throw new Error('Publication graph capacity');
  }
  async function json<T>(
    key: string,
    schema: { parse(value: unknown): T },
    limit = MAX_PUBLIC_JSON_BYTES,
    checksum?: string,
  ) {
    const bytes = await read(key, limit);
    if (
      bytes.length > limit ||
      (checksum && (bytes.length !== limit || sha256(bytes) !== checksum))
    )
      throw new Error('Public reference checksum/size mismatch');
    const value = schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    assertPublicData(value);
    add({ key, bytes: bytes.length, checksum: sha256(bytes) });
    return value;
  }
  const current = await json('catalog/current.json', PublicCatalogCurrentSchema);
  let hash: string | null = current.catalogHash,
    expectedBytes: number | undefined = current.bytes;
  const generations = new Set<string>();
  let catalog: ReturnType<typeof PublicCatalogSchema.parse> | undefined;
  while (hash) {
    if (generations.has(hash) || generations.size >= 1000)
      throw new Error('Invalid catalog ancestry');
    generations.add(hash);
    const key = `catalog/${publicHashName(hash)}.json`;
    // Historical catalog sizes are not stored in their successor; hash still binds every byte.
    const bytes = await read(key, expectedBytes ?? MAX_PUBLIC_JSON_BYTES);
    if (sha256(bytes) !== hash || (expectedBytes !== undefined && bytes.length !== expectedBytes))
      throw new Error('Catalog checksum mismatch');
    const generation = PublicCatalogSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    assertPublicData(generation);
    add({ key, bytes: bytes.length, checksum: hash });
    catalog ??= generation;
    for (const ref of generation.sets) {
      const prefix = `sets/${publicHashName(ref.setHash)}/`;
      if (sets.has(ref.setHash)) {
        if (files.get(prefix + 'set.json')?.bytes !== ref.bytes)
          throw new Error('Retained set size mismatch');
        continue;
      }
      const set = await json(prefix + 'set.json', PublicReplaySetSchema, ref.bytes, ref.setHash);
      sources.add(set.source.sha);
      sets.set(ref.setHash, set);
      const counts = { complete: 0, failed: 0, unresolved: 0, truncated: 0, pending: 0 };
      let lastSlot = '';
      for (const pageRef of set.pages) {
        const page = await json(
          prefix + publicHashName(pageRef.pageHash) + '.json',
          PublicMatchPageSchema,
          pageRef.bytes,
          pageRef.pageHash,
        );
        assertPublicPageBinding(set, page);
        if (page.index !== pageRef.index) throw new Error('Public page index mismatch');
        for (const row of page.rows) {
          if (row.slotId <= lastSlot) throw new Error('Public rows are not globally ordered');
          lastSlot = row.slotId;
          counts[row.state]++;
          if (!row.replay) continue;
          const objectPrefix = `objects/${publicHashName(row.replay.objectHash)}/`;
          const receiptData = await read(objectPrefix + 'receipt.json', row.replay.receiptBytes);
          if (
            receiptData.length !== row.replay.receiptBytes ||
            sha256(receiptData) !== row.replay.receiptChecksum
          )
            throw new Error('Receipt checksum mismatch');
          const receipt = receiptIdentity(objectPrefix + 'receipt.json', receiptData, results);
          assertPublicData(receipt);
          add({
            key: objectPrefix + 'receipt.json',
            bytes: receiptData.length,
            checksum: sha256(receiptData),
          });
          const manifestBytes = await read(
            objectPrefix + 'manifest.json',
            MAX_REPLAY_MANIFEST_BYTES,
          );
          if (sha256(manifestBytes) !== receipt.manifestChecksum)
            throw new Error('Manifest checksum mismatch');
          const manifest = ReplayManifestSchema.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)),
          );
          assertPublicData(manifest);
          assertPublicReplayBinding(row, receipt, manifest);
          if (
            canonicalJson(receipt.source) !== canonicalJson(set.source) ||
            manifest.input.engineVersion !== set.engineVersion ||
            manifest.input.implementationDigest !== set.implementationDigest
          )
            throw new Error('Public source identity mismatch');
          add({
            key: objectPrefix + 'manifest.json',
            bytes: manifestBytes.length,
            checksum: receipt.manifestChecksum,
          });
          for (const artifact of [...manifest.chunks, ...manifest.checkpoints]) {
            const file = {
              key: objectPrefix + artifact.file,
              bytes: artifact.bytes,
              checksum: artifact.checksum,
            };
            if (!files.has(file.key)) {
              const data = await read(file.key, file.bytes);
              if (data.length !== file.bytes || sha256(data) !== file.checksum)
                throw new Error('Retained artifact checksum/size mismatch');
            }
            add(file);
          }
          objects.add(receipt.objectHash);
        }
      }
      if (canonicalJson(counts) !== canonicalJson(set.counts))
        throw new Error('Public state counts mismatch');
    }
    hash = generation.previousCatalogHash;
    expectedBytes = undefined;
  }
  return { current, catalog: catalog!, files, sources, results, objects, sets, totalBytes };
}

export async function localPublicationGraph(root: string) {
  const read: PublicationRead = async (key, limit) => {
    await publicationDirectory(dirname(join(root, key)));
    return readBoundedFile(join(root, key), limit);
  };
  const graph = await publicationGraph(read);
  for (const file of graph.files.values()) file.source = join(root, file.key);
  const bundles = new BattleBundles(root);
  for (const objectHash of graph.objects) {
    await bundles.verify(objectHash);
    const prefix = `objects/${publicHashName(objectHash)}/`;
    const manifest = ReplayManifestSchema.parse(
      JSON.parse(
        (await read(prefix + 'manifest.json', MAX_REPLAY_MANIFEST_BYTES)).toString('utf8'),
      ),
    );
    for (const artifact of [...manifest.chunks, ...manifest.checkpoints])
      await inspectPublicArtifact(graph.files.get(prefix + artifact.file)!, artifact.rawBytes);
  }
  return graph;
}
