import { OperationError, operationInput } from '@fantasy/api/tooling';
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
  compareIds,
  publicHashName,
  type PublicReplaySet,
  type PublicMatchPage,
  type PublicCatalog,
  type BundleReceipt,
  type ReplayManifest,
  type LeagueFileRef,
} from '@fantasy/domain/spatial';
import { BattleBundles, withReplayVerificationPool } from '@fantasy/api/artifacts';
import { readBoundedFile, sha256 } from '@fantasy/api/artifacts';
import {
  assertPublicData,
  publicationDirectory,
  PUBLICATION_MAX_BYTES,
  PUBLICATION_MAX_FILES,
  receiptIdentity,
  type PublicationFile,
} from './publication-files.ts';

import { publicationConcurrency, publicationPool } from './publication-pool.ts';
import type { LeagueJson } from '../league/league-metadata.ts';

export type PublicationRead = ((key: string, limit: number) => Promise<Buffer>) & {
  prefetch?(files: readonly Pick<PublicationFile, 'key' | 'bytes' | 'checksum'>[]): Promise<void>;
};

function orderedEntries<T>(entries: Map<string, T>) {
  return new Map([...entries].sort(([a], [b]) => compareIds(a, b)));
}

/** Traverse all retained generations, validating content-addressed references before any mutation. */
export async function publicationGraph(source: PublicationRead, concurrency = 1) {
  publicationConcurrency(concurrency, 64);
  const files = new Map<string, PublicationFile>(),
    sources = new Set<string>();
  const results = new Map<string, string>(),
    objects = new Set<string>(),
    sets = new Map<string, PublicReplaySet>();
  const pages = new Map<string, PublicMatchPage>(),
    receipts = new Map<string, BundleReceipt>();
  const leagues = new Map<string, NonNullable<PublicCatalog['leagues']>[number]>();
  const leagueWork = new Map<string, LeagueFileRef>();
  const catalogs: PublicCatalog[] = [];
  let latestWork: Awaited<
    ReturnType<typeof import('../league/league-graph.ts').validatePublicLeagueWork>
  > | null = null;
  let totalBytes = 0,
    reads = 0,
    readBytes = 0;
  const read: PublicationRead = async (key, limit) => {
    if (++reads > PUBLICATION_MAX_FILES)
      throw new OperationError('BUDGET_EXCEEDED', 'Publication graph read limit');
    const bytes = await source(key, limit);
    readBytes += bytes.length;
    if (bytes.length > limit || readBytes > PUBLICATION_MAX_BYTES)
      throw new OperationError('BUDGET_EXCEEDED', 'Publication graph byte limit');
    return bytes;
  };
  function add(file: PublicationFile) {
    const old = files.get(file.key);
    if (old && (old.checksum !== file.checksum || old.bytes !== file.bytes))
      throw new OperationError('DATA_INVALID', 'Conflicting public reference');
    if (!old) {
      files.set(file.key, file);
      totalBytes += file.bytes;
    }
    if (files.size > PUBLICATION_MAX_FILES || totalBytes > PUBLICATION_MAX_BYTES)
      throw new OperationError('BUDGET_EXCEEDED', 'Publication graph capacity');
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
      throw new OperationError('DATA_INVALID', 'Public reference checksum/size mismatch');
    const value = operationInput(
      () => schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))),
      'DATA_INVALID',
    );
    assertPublicData(value);
    add({ key, bytes: bytes.length, checksum: sha256(bytes) });
    return value;
  }
  const bundles = new Map<string, Promise<{ receipt: BundleReceipt; manifest: ReplayManifest }>>();
  function bundle(objectHash: string) {
    let promise = bundles.get(objectHash);
    if (!promise) {
      promise = (async () => {
        const objectPrefix = `objects/${publicHashName(objectHash)}/`;
        const receiptData = await read(objectPrefix + 'receipt.json', 65536);
        const receipt = receiptIdentity(objectPrefix + 'receipt.json', receiptData, results);
        receipts.set(receipt.objectHash, receipt);
        assertPublicData(receipt);
        add({
          key: objectPrefix + 'receipt.json',
          bytes: receiptData.length,
          checksum: sha256(receiptData),
        });
        const manifestBytes = await read(objectPrefix + 'manifest.json', MAX_REPLAY_MANIFEST_BYTES);
        if (sha256(manifestBytes) !== receipt.manifestChecksum)
          throw new OperationError('DATA_INVALID', 'Manifest checksum mismatch');
        const manifest = operationInput(
          () =>
            ReplayManifestSchema.parse(
              JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)),
            ),
          'DATA_INVALID',
        );
        assertPublicData(manifest);
        add({
          key: objectPrefix + 'manifest.json',
          bytes: manifestBytes.length,
          checksum: receipt.manifestChecksum,
        });
        await source.prefetch?.(
          [...manifest.chunks, ...manifest.checkpoints].map((ref) => ({
            key: objectPrefix + ref.file,
            bytes: ref.bytes,
            checksum: ref.checksum,
          })),
        );
        for (const artifact of [...manifest.chunks, ...manifest.checkpoints]) {
          const file = {
            key: objectPrefix + artifact.file,
            bytes: artifact.bytes,
            checksum: artifact.checksum,
          };
          if (!files.has(file.key)) {
            const data = await read(file.key, file.bytes);
            if (data.length !== file.bytes || sha256(data) !== file.checksum)
              throw new OperationError('DATA_INVALID', 'Retained artifact checksum/size mismatch');
          }
          add(file);
        }
        objects.add(receipt.objectHash);
        return { receipt, manifest };
      })();
      bundles.set(objectHash, promise);
    }
    return promise;
  }
  const current = await json('catalog/current.json', PublicCatalogCurrentSchema);
  let hash: string | null = current.catalogHash,
    expectedBytes: number | undefined = current.bytes;
  const generations = new Set<string>();
  let catalog: ReturnType<typeof PublicCatalogSchema.parse> | undefined;
  while (hash) {
    if (generations.has(hash) || generations.size >= 1000)
      throw new OperationError('DATA_INVALID', 'Invalid catalog ancestry');
    generations.add(hash);
    const key: string = `catalog/${publicHashName(hash)}.json`;
    // Historical catalog sizes are not stored in their successor; hash still binds every byte.
    const bytes: Buffer = await read(key, expectedBytes ?? MAX_PUBLIC_JSON_BYTES);
    if (sha256(bytes) !== hash || (expectedBytes !== undefined && bytes.length !== expectedBytes))
      throw new OperationError('DATA_INVALID', 'Catalog checksum mismatch');
    const generation: PublicCatalog = operationInput(
      () =>
        PublicCatalogSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        ),
      'DATA_INVALID',
    );
    assertPublicData(generation);
    add({ key, bytes: bytes.length, checksum: hash });
    catalog ??= generation;
    catalogs.push(generation);
    for (const ref of generation.leagues ?? []) {
      const prior = leagues.get(ref.hash);
      if (prior && canonicalJson(prior) !== canonicalJson(ref))
        throw new OperationError('DATA_INVALID', 'Conflicting league catalog reference');
      leagues.set(ref.hash, ref);
    }
    if (generation.leagueWork) {
      const ref = generation.leagueWork;
      if (leagueWork.has(ref.hash) && leagueWork.get(ref.hash)!.bytes !== ref.bytes)
        throw new OperationError('DATA_INVALID', 'Conflicting league work size');
      leagueWork.set(ref.hash, ref);
    }
    await source.prefetch?.(
      generation.sets
        .filter((ref) => !sets.has(ref.setHash))
        .map((ref) => ({
          key: `sets/${publicHashName(ref.setHash)}/set.json`,
          bytes: ref.bytes,
          checksum: ref.setHash,
        })),
    );
    for (const ref of generation.sets) {
      const prefix = `sets/${publicHashName(ref.setHash)}/`;
      if (sets.has(ref.setHash)) {
        if (files.get(prefix + 'set.json')?.bytes !== ref.bytes)
          throw new OperationError('DATA_INVALID', 'Retained set size mismatch');
        continue;
      }
      const set = await json(prefix + 'set.json', PublicReplaySetSchema, ref.bytes, ref.setHash);
      sources.add(set.source.sha);
      sets.set(ref.setHash, set);
      const counts = { complete: 0, failed: 0, unresolved: 0, truncated: 0, pending: 0 };
      let lastSlot = '';
      await source.prefetch?.(
        set.pages.map((ref) => ({
          key: prefix + publicHashName(ref.pageHash) + '.json',
          bytes: ref.bytes,
          checksum: ref.pageHash,
        })),
      );
      for (const pageRef of set.pages) {
        const page = await json(
          prefix + publicHashName(pageRef.pageHash) + '.json',
          PublicMatchPageSchema,
          pageRef.bytes,
          pageRef.pageHash,
        );
        assertPublicPageBinding(set, page);
        pages.set(`${ref.setHash}/${pageRef.pageHash}`, page);
        if (page.index !== pageRef.index)
          throw new OperationError('DATA_INVALID', 'Public page index mismatch');
        for (const row of page.rows) {
          if (row.slotId <= lastSlot)
            throw new OperationError('DATA_INVALID', 'Public rows are not globally ordered');
          lastSlot = row.slotId;
          counts[row.state]++;
        }
        await publicationPool(
          page.rows,
          concurrency,
          async (row) => {
            if (!row.replay) return;
            const { receipt, manifest } = await bundle(row.replay.objectHash);
            const reference = files.get(
              `objects/${publicHashName(row.replay.objectHash)}/receipt.json`,
            )!;
            if (
              reference.bytes !== row.replay.receiptBytes ||
              reference.checksum !== row.replay.receiptChecksum
            )
              throw new OperationError('DATA_INVALID', 'Receipt checksum mismatch');
            assertPublicReplayBinding(row, receipt, manifest);
            if (
              (!row.reused && canonicalJson(receipt.source) !== canonicalJson(set.source)) ||
              manifest.input.engineVersion !== set.engineVersion ||
              manifest.input.implementationDigest !== set.implementationDigest
            )
              throw new OperationError('DATA_INVALID', 'Public source identity mismatch');
            sources.add(receipt.source.sha);
          },
          'restore.rows',
          64,
        );
      }
      if (canonicalJson(counts) !== canonicalJson(set.counts))
        throw new OperationError('DATA_INVALID', 'Public state counts mismatch');
    }
    hash = generation.previousCatalogHash;
    expectedBytes = undefined;
  }
  if (leagues.size || leagueWork.size) {
    const { validatePublicLeague, validatePublicLeagueWork, assertLeagueWorkTransition } =
      await import('../league/league-graph.ts');
    const cached = new Map<string, { bytes: number; value: unknown }>();
    const leagueJson: LeagueJson = async <T>(
      ref: LeagueFileRef,
      schema: { parse(value: unknown): T },
    ): Promise<T> => {
      const old = cached.get(ref.hash);
      if (old && old.bytes !== ref.bytes)
        throw new OperationError('DATA_INVALID', 'League reference size mismatch');
      if (old) return operationInput(() => schema.parse(old.value), 'DATA_INVALID');
      const value = await json(
        `leagues/${publicHashName(ref.hash)}.json`,
        schema,
        ref.bytes,
        ref.hash,
      );
      cached.set(ref.hash, { bytes: ref.bytes, value });
      return value;
    };
    leagueJson.prefetch = source.prefetch
      ? async (refs: readonly LeagueFileRef[]) =>
          source.prefetch!(
            refs.map((ref) => ({
              key: `leagues/${publicHashName(ref.hash)}.json`,
              bytes: ref.bytes,
              checksum: ref.hash,
            })),
          )
      : undefined;
    await leagueJson.prefetch?.([...leagues.values(), ...leagueWork.values()]);
    for (const ref of leagues.values()) {
      const snapshot = await validatePublicLeague(ref, leagueJson, sets, pages);
      sources.add(snapshot.sourceSha);
    }
    const workStates = new Map<string, Awaited<ReturnType<typeof validatePublicLeagueWork>>>();
    for (const ref of leagueWork.values()) {
      const state = await validatePublicLeagueWork(ref, leagueJson, receipts),
        { work } = state;
      if (work.previousWork && !leagueWork.has(work.previousWork.hash))
        throw new OperationError('DATA_INVALID', 'Missing retained league work generation');
      workStates.set(ref.hash, state);
      sources.add(work.sourceSha);
    }
    for (const state of workStates.values())
      if (state.work.previousWork) {
        const ref = leagueWork.get(state.work.previousWork.hash)!;
        if (ref.bytes !== state.work.previousWork.bytes)
          throw new OperationError('DATA_INVALID', 'League work ancestor size mismatch');
        assertLeagueWorkTransition(workStates.get(ref.hash)!, state);
      }
    let previousWork: LeagueFileRef | undefined;
    for (const generation of catalogs.reverse()) {
      const currentWork = generation.leagueWork;
      if (previousWork && !currentWork)
        throw new OperationError('DATA_INVALID', 'Catalog drops the durable league journal');
      if (
        currentWork &&
        currentWork.hash !== previousWork?.hash &&
        canonicalJson(workStates.get(currentWork.hash)!.work.previousWork) !==
          canonicalJson(previousWork ?? null)
      )
        throw new OperationError('DATA_INVALID', 'Catalog rewinds the durable league journal');
      previousWork = currentWork;
    }
    latestWork = catalog?.leagueWork ? workStates.get(catalog.leagueWork.hash)! : null;
  }
  // I/O completion order must not leak into downstream traversal or publication output.
  return {
    current,
    catalog: catalog!,
    files: orderedEntries(files),
    sources: new Set([...sources].sort(compareIds)),
    results: orderedEntries(results),
    objects: new Set([...objects].sort(compareIds)),
    sets: orderedEntries(sets),
    totalBytes,
    latestWork,
  };
}

export async function localPublicationGraph(
  root: string,
  verificationWorkers = 1,
  signal?: AbortSignal,
  graphReadConcurrency = 4,
) {
  publicationConcurrency(graphReadConcurrency, 64);
  signal?.throwIfAborted();
  const read: PublicationRead = async (key, limit) => {
    signal?.throwIfAborted();
    await publicationDirectory(dirname(join(root, key)));
    return readBoundedFile(join(root, key), limit);
  };
  const graph = await publicationGraph(read, graphReadConcurrency);
  for (const file of graph.files.values()) file.source = join(root, file.key);
  return withReplayVerificationPool(
    verificationWorkers,
    async (pool) => {
      const bundles = new BattleBundles(root).verificationSession({
        publicData: true,
        ...(signal ? { signal } : {}),
        ...(pool ? { pool } : {}),
      });
      try {
        await bundles.preverify([...graph.objects]);
        signal?.throwIfAborted();
        return graph;
      } finally {
        bundles.closeVerification();
      }
    },
    signal,
  );
}
