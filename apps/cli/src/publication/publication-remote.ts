import { evidenceGraph, evidenceMd5, type PublicationEvidence } from './publication-evidence.ts';
import { OperationError, operationInput } from '@fantasy/api/tooling';
import { ReaderBuildSchema, ViewerBuildSchema } from '@fantasy/domain';
import {
  PackIndexSchema,
  packKey,
  PACK_INDEX_BYTES,
  type PackRange,
  PublicCatalogCurrentSchema,
  PublicCatalogSchema,
  publicHashName,
} from '@fantasy/domain/spatial';
import { localPublicationGraph, publicationGraph } from './publication-graph.ts';
import {
  publicationBytes,
  receiptIdentity,
  PUBLICATION_MAX_BYTES,
  PUBLICATION_MAX_FILES,
  PUBLICATION_CONTROL_KEY,
  type PublicationFile,
} from './publication-files.ts';
import { createHash } from 'node:crypto';
import { sha256 } from '@fantasy/api/artifacts';
import { publicationConcurrency, publicationPool } from './publication-pool.ts';
import { PublicationIo, transferTuning, type TransferTuning } from './publication-io.ts';

export interface RemoteObject {
  data: Buffer;
  etag: string;
}
export interface PublicationStore {
  remainingRequests(): number;
  inventory(): Promise<Map<string, number>>;
  read(key: string, limit: number): Promise<RemoteObject | null>;
  head(key: string): Promise<number | null>;
  put(key: string, data: Buffer, previousEtag: string | null): Promise<void>;
  remove(key: string): Promise<void>;
  /** ETags recorded by the latest `inventory()`, when the store lists them. */
  listedEtags?(): ReadonlyMap<string, string>;
}
/** Starts transport and reserves usage only after the complete local graph is verified. */
export type PublicationStoreFactory = (
  graph: Awaited<ReturnType<typeof localPublicationGraph>>,
) => Promise<
  | PublicationStore
  | {
      store: PublicationStore;
      inventory: ReadonlyMap<string, number>;
      etags?: ReadonlyMap<string, string>;
    }
>;
export interface PublishOptions extends TransferTuning {
  viewer(): Promise<unknown>;
  ancestor(source: string, viewer: string): boolean;
  worker: ((key: string, limit: number, range?: PackRange) => Promise<Buffer>) & {
    readerBuild?(): unknown;
  };
  maxBytes?: number;
  maxWrites?: number;
  maxTransferBytes?: number;
  maxWorkerRequests?: number;
  concurrency?: number;
  verificationWorkers?: number;
  graphReadConcurrency?: number;
  signal?: AbortSignal;
  dryRun?: boolean;
  observe?(report: PublishReport): void;
}
export interface PublishReport {
  catalogHash: string;
  storedBytes: number;
  projectedBytes: number;
  addedFiles: number;
  reusedFiles: number;
  writes: number;
  transferBytes: number;
  workerRequests: number;
  reservedS3Requests: number;
  incompleteRows: number;
  viewerSourceSha?: string;
  readerSourceSha?: string;
}
function limit(value: number | undefined, fallback: number, upper: number) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > upper)
    throw new OperationError('INPUT_INVALID', 'Invalid publication budget');
  return n;
}
const rank = (key: string) =>
  key.startsWith('objects/') || key.startsWith('packs/')
    ? 0
    : key.startsWith('pack-indexes/')
      ? 1
      : key.startsWith('sets/')
        ? key.endsWith('/set.json')
          ? 2
          : 1
        : key.startsWith('leagues/')
          ? 3
          : 4;
function exactBytes(file: PublicationFile, value: RemoteObject | null) {
  if (!value || value.data.length !== file.bytes || sha256(value.data) !== file.checksum)
    throw new OperationError('DATA_INVALID', 'Immutable publication collision');
  return value;
}
async function exact(store: PublicationStore, file: PublicationFile) {
  return exactBytes(file, await store.read(file.key, file.bytes));
}
/**
 * A listed single-part ETag equal to the MD5 of the verified local bytes (with equal size)
 * proves identical content without downloading it; anything else falls back to a full GET.
 */
async function listedMatch(
  file: PublicationFile,
  size: number | undefined,
  etag: string | undefined,
  authenticatedMd5?: string,
) {
  const md5 = /^"?([a-f0-9]{32})"?$/i.exec(etag ?? '')?.[1]?.toLowerCase();
  if (!md5 || size !== file.bytes) return false;
  if (authenticatedMd5) return md5 === authenticatedMd5;
  return (
    createHash('md5')
      .update(await publicationBytes(file))
      .digest('hex') === md5
  );
}
export type PublicationPhase = 'not-committed' | 'commit-unknown' | 'committed-unverified';
export class PublicationFailure extends Error {
  constructor(
    readonly phase: PublicationPhase,
    cause: unknown,
  ) {
    // Causes stay local; CLI emits only this fixed, credential-free recovery instruction.
    super(`Publication ${phase}; rerun the same publication after correcting the failure.`, {
      cause,
    });
  }
}
/** Bounded stage barriers; S3 conditional writes make pointer replacement atomic. */
export async function publishPublication(
  root: string,
  destination: PublicationStore | PublicationStoreFactory,
  options: PublishOptions,
) {
  try {
    return await publishGraph(
      await localPublicationGraph(
        root,
        options.verificationWorkers ?? 1,
        options.signal,
        options.graphReadConcurrency ?? 4,
      ),
      destination,
      options,
    );
  } catch (error) {
    if (error instanceof PublicationFailure) throw error;
    throw new PublicationFailure('not-committed', error);
  }
}

export async function publishPublicationEvidence(
  evidence: PublicationEvidence,
  destination: PublicationStore | PublicationStoreFactory,
  options: PublishOptions,
) {
  return publishGraph(evidenceGraph(evidence), destination, options, evidence);
}

async function publishGraph(
  graph: Awaited<ReturnType<typeof publicationGraph>>,
  destination: PublicationStore | PublicationStoreFactory,
  options: PublishOptions,
  evidence?: PublicationEvidence,
) {
  let phase: PublicationPhase = 'not-committed';
  let io: PublicationIo | undefined;
  try {
    const maxBytes = limit(options.maxBytes, PUBLICATION_MAX_BYTES, PUBLICATION_MAX_BYTES);
    const maxWrites = limit(options.maxWrites, 10000, PUBLICATION_MAX_FILES);
    const maxTransfer = limit(options.maxTransferBytes, 256_000_000, PUBLICATION_MAX_BYTES);
    const maxWorker = limit(options.maxWorkerRequests, 200, 1000);
    const concurrency = publicationConcurrency(options.concurrency);
    const tuning = transferTuning(options, concurrency);
    io = new PublicationIo(tuning.sockets, tuning.bytes, options.signal);
    const transfer = io;
    const session = typeof destination === 'function' ? await destination(graph) : destination;
    const store = 'store' in session ? session.store : session;
    let viewerSourceSha = '';
    const compatible = async () => {
      const viewer = ViewerBuildSchema.parse(await options.viewer());
      if (viewer.publicationSchema < graph.current.schemaVersion)
        throw new OperationError(
          'IDENTITY_MISMATCH',
          'Published viewer does not support packed replays',
        );
      viewerSourceSha = viewer.sourceSha;
      for (const source of graph.sources)
        if (!options.ancestor(source, viewer.sourceSha))
          throw new OperationError(
            'IDENTITY_MISMATCH',
            'Data source is not an ancestor of the published viewer',
          );
    };
    await compatible();
    const pointer = graph.files.get('catalog/current.json')!;
    const previous = await store.read(pointer.key, 4_000_000);
    const remoteCurrent = previous
      ? operationInput(
          () =>
            PublicCatalogCurrentSchema.parse(
              JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(previous.data)),
            ),
          'DATA_INVALID',
        )
      : null;
    const unchanged = previous !== null && sha256(previous.data) === pointer.checksum;
    if (unchanged) phase = 'committed-unverified';
    if (!unchanged && graph.catalog.previousCatalogHash !== (remoteCurrent?.catalogHash ?? null))
      throw new OperationError('PUBLICATION_CONFLICT', 'Publication generation changed');
    let priorSets = new Set<string>();
    if (remoteCurrent) {
      const old = await exact(store, {
        key: `catalog/${publicHashName(remoteCurrent.catalogHash)}.json`,
        bytes: remoteCurrent.bytes,
        checksum: remoteCurrent.catalogHash,
      });
      priorSets = new Set(
        operationInput(
          () =>
            PublicCatalogSchema.parse(
              JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(old.data)),
            ),
          'DATA_INVALID',
        ).sets.map((s) => s.setHash),
      );
    }
    // A factory snapshot is collected after graph verification, never persisted across commands.
    const inventory = new Map('store' in session ? session.inventory : await store.inventory());
    const etags = 'store' in session ? session.etags : store.listedEtags?.();
    // Keys whose stored bytes this publication proved identical (GET, ETag or successful PUT).
    const present = new Set<string>();
    const resultHashes = new Map(graph.results);
    const exactReceipts = new Set<string>();
    await publicationPool(
      [...inventory.keys()].filter((key) => key.endsWith('/receipt.json')),
      tuning.read,
      async (key) => {
        const expected = graph.files.get(key);
        // Only the fully verified local graph can supply receipt/result identity evidence.
        // Orphans still require a GET even when the listing provides an MD5 ETag.
        if (
          expected &&
          (await transfer.run(expected.bytes, () =>
            listedMatch(
              expected,
              inventory.get(key),
              etags?.get(key),
              evidence && evidenceMd5(evidence, expected),
            ),
          ))
        ) {
          exactReceipts.add(key);
          return;
        }
        await transfer.run(65536, async () => {
          const value = await store.read(key, 65536);
          if (!value) throw new OperationError('DATA_INVALID', 'Remote receipt disappeared');
          receiptIdentity(key, value.data, resultHashes);
          if (expected) {
            exactBytes(expected, value);
            exactReceipts.add(key);
          }
        });
      },
      'r2.receipts',
      64,
    );
    // Retained orphan packs participate in the same immutable canonical-result check.
    for (const key of inventory.keys())
      if (key.startsWith('pack-indexes/') && !graph.files.has(key)) {
        const indexObject = await transfer.run(PACK_INDEX_BYTES, () =>
          store.read(key, PACK_INDEX_BYTES),
        );
        if (
          !indexObject ||
          sha256(indexObject.data).slice(7) + '.json' !== key.slice('pack-indexes/'.length)
        )
          throw new OperationError('DATA_INVALID', 'Remote pack index checksum mismatch');
        const index = PackIndexSchema.parse(JSON.parse(indexObject.data.toString('utf8')));
        await transfer.run(index.packBytes, async () => {
          const value = await store.read(packKey(index.packHash), index.packBytes);
          if (
            !value ||
            value.data.length !== index.packBytes ||
            sha256(value.data) !== index.packHash
          )
            throw new OperationError('DATA_INVALID', 'Remote orphan pack checksum mismatch');
          for (const entry of index.entries)
            if (entry.key.endsWith('/receipt.json')) {
              const data = value.data.subarray(entry.offset, entry.offset + entry.bytes);
              if (sha256(data) !== entry.checksum)
                throw new OperationError('DATA_INVALID', 'Remote packed receipt checksum mismatch');
              receiptIdentity(entry.key, data, resultHashes);
            }
        });
      }
    const additions: PublicationFile[] = [];
    await publicationPool(
      [...graph.files.values()],
      tuning.read,
      async (file) => {
        if (file.key !== pointer.key) {
          if (inventory.has(file.key)) {
            // The local MD5 proof reads the whole file, so it shares the in-flight byte budget.
            if (
              !exactReceipts.has(file.key) &&
              !(await transfer.run(file.bytes, () =>
                listedMatch(
                  file,
                  inventory.get(file.key),
                  etags?.get(file.key),
                  evidence && evidenceMd5(evidence, file),
                ),
              ))
            )
              await transfer.run(file.bytes, () => exact(store, file));
            present.add(file.key);
          } else additions.push(file);
        }
      },
      'r2.collisions',
      64,
    );
    const selected = new Set<string>([
      pointer.key,
      `catalog/${publicHashName(graph.current.catalogHash)}.json`,
    ]);
    const fresh = graph.catalog.sets.filter((s) => !priorSets.has(s.setHash));
    for (const ref of fresh.length ? fresh : graph.catalog.sets.slice(0, 1)) {
      const prefix = `sets/${publicHashName(ref.setHash)}/`,
        set = graph.sets.get(ref.setHash)!;
      selected.add(prefix + 'set.json');
      for (const page of set.pages) selected.add(prefix + publicHashName(page.pageHash) + '.json');
    }
    const sample = [...graph.objects].sort()[0];
    for (const ref of graph.catalog.leagues ?? [])
      selected.add(`leagues/${publicHashName(ref.hash)}.json`);
    if (graph.catalog.leagueWork)
      selected.add(`leagues/${publicHashName(graph.catalog.leagueWork.hash)}.json`);
    if (sample)
      for (const key of graph.files.keys())
        if (key.startsWith(`objects/${publicHashName(sample)}/`)) selected.add(key);
    const sampleIndex = [...graph.files.values()].find((file) =>
      file.key.startsWith('pack-indexes/'),
    );
    const packedSample = sampleIndex
      ? PackIndexSchema.parse(JSON.parse((await publicationBytes(sampleIndex)).toString('utf8')))
      : null;
    if (sampleIndex) selected.add(sampleIndex.key);
    const storedBytes = [...inventory.values()].reduce((sum, n) => sum + n, 0);
    const transferBytes =
      additions.reduce((sum, f) => sum + f.bytes, 0) + (unchanged ? 0 : pointer.bytes);
    const report: PublishReport = {
      catalogHash: graph.current.catalogHash,
      storedBytes,
      projectedBytes: storedBytes + transferBytes - (unchanged ? 0 : (previous?.data.length ?? 0)),
      addedFiles: additions.length,
      reusedFiles: graph.files.size - 1 - additions.length,
      writes: additions.length + (unchanged ? 0 : 1),
      transferBytes,
      workerRequests: selected.size + (packedSample ? 2 : 0),
      ...(graph.current.schemaVersion === 2 ? { viewerSourceSha } : {}),
      // Remaining normal requests: PUT + uncertain-response GET per addition, two generation
      // reads, pointer GET/HEAD, and optional pointer PUT + recovery GET. No full-graph HEAD.
      // Inventory/collisions are already charged; counted retries draw on the lease headroom.
      reservedS3Requests: additions.length * 2 + 4 + (unchanged ? 0 : 2),
      incompleteRows: [...graph.sets.values()].reduce((n, set) => n + set.incompleteRows, 0),
    };
    options.observe?.(report);
    if (
      report.projectedBytes > maxBytes ||
      report.writes > maxWrites ||
      report.transferBytes > maxTransfer ||
      report.reservedS3Requests > store.remainingRequests() ||
      inventory.size + additions.length + (previous ? 0 : 1) > PUBLICATION_MAX_FILES ||
      report.workerRequests > maxWorker
    )
      throw new OperationError(
        'BUDGET_EXCEEDED',
        'Publication capacity/request budget exceeded before writing',
      );
    // Empty inventories queue no remote I/O, so the queue alone cannot observe cancellation.
    options.signal?.throwIfAborted();
    if (options.dryRun) return { status: 'planned' as const, ...report };
    const verifyReader = async () => {
      if (packedSample) {
        const entry = packedSample.entries[0]!;
        const data = await options.worker(packKey(packedSample.packHash), entry.bytes, {
          offset: entry.offset,
          bytes: entry.bytes,
          total: packedSample.packBytes,
        });
        if (data.length !== entry.bytes || sha256(data) !== entry.checksum)
          throw new OperationError('DATA_INVALID', 'Reader pack capability check failed');
        const reader = ReaderBuildSchema.parse(options.worker.readerBuild?.());
        report.readerSourceSha = reader.sourceSha;
      }
    };
    const sameGeneration = async () => {
      const now = await store.read(pointer.key, 4_000_000);
      if (
        (previous === null) !== (now === null) ||
        (previous && (!now || now.etag !== previous.etag || !now.data.equals(previous.data)))
      )
        throw new OperationError('PUBLICATION_CONFLICT', 'Publication generation changed');
    };
    await sameGeneration();
    additions.sort((a, b) => a.key.localeCompare(b.key));
    for (let stage = 0; stage <= 4; stage++) {
      await publicationPool(
        additions.filter((file) => rank(file.key) === stage),
        tuning.write,
        (file) =>
          transfer.run(file.bytes, async () => {
            try {
              await store.put(file.key, await publicationBytes(file), null);
            } catch (error) {
              // A lost response may follow a successful conditional PUT. Only identical bytes recover it.
              try {
                await exact(store, file);
              } catch {
                throw error;
              }
            }
            present.add(file.key);
          }),
        'r2.upload',
        64,
      );
    }
    // All referenced immutable objects must be present before committing current.json.
    // Objects proved in this serialized publication skip the extra HEAD.
    await publicationPool(
      [...graph.files.values()].filter((file) => !present.has(file.key)),
      tuning.head,
      (file) =>
        transfer.run(0, async () => {
          if (file.key !== pointer.key && (await store.head(file.key)) !== file.bytes)
            throw new OperationError('DATA_INVALID', 'S3 size verification failed');
        }),
      'r2.head',
      64,
    );
    // Prove actual dual-reader capability before exposing any v2 pointer.
    await verifyReader();
    await compatible();
    if (graph.current.schemaVersion === 2) report.viewerSourceSha = viewerSourceSha;
    await sameGeneration();
    options.signal?.throwIfAborted();
    if (!unchanged) {
      phase = 'commit-unknown';
      try {
        await store.put(pointer.key, await publicationBytes(pointer), previous?.etag ?? null);
      } catch (error) {
        try {
          await exact(store, pointer);
        } catch {
          throw error;
        }
      }
    }
    phase = 'committed-unverified';
    await exact(store, pointer);
    if ((await store.head(pointer.key)) !== pointer.bytes)
      throw new OperationError('DATA_INVALID', 'S3 pointer verification failed');
    await publicationPool([...selected], concurrency, async (key) => {
      const file = graph.files.get(key)!;
      await transfer.run(file.bytes, async () => {
        const data = await options.worker(key, file.bytes);
        if (data.length !== file.bytes || sha256(data) !== file.checksum)
          throw new OperationError('DATA_INVALID', 'Worker read-back checksum mismatch');
      });
    });
    await verifyReader();
    return { status: 'verified' as const, ...report };
  } catch (error) {
    throw new PublicationFailure(phase, error);
  } finally {
    await io?.close();
  }
}

/** Explicit orphan cleanup only: every ancestor generation is retained; default is a dry run. */
export async function prunePublication(store: PublicationStore, confirm = false) {
  const before = await store.read('catalog/current.json', 4_000_000);
  if (!before) throw new Error('No published generation; orphan deletion requires manual recovery');
  const graph = await publicationGraph(async (key, limit) => {
    const value = await store.read(key, limit);
    if (!value) throw new Error('Retained publication is incomplete');
    return value.data;
  });
  const inventory = await store.inventory();
  const keys = [...inventory.keys()].filter(
    (key) => key !== PUBLICATION_CONTROL_KEY && !graph.files.has(key),
  );
  if (keys.length > 10000) throw new Error('Orphan deletion request limit');
  if (confirm && keys.length * 2 > store.remainingRequests())
    throw new Error('Orphan deletion request budget');
  for (const key of confirm ? keys : []) {
    const current = await store.read('catalog/current.json', 4_000_000);
    if (!current || current.etag !== before.etag || !current.data.equals(before.data))
      throw new Error('Publication generation changed during cleanup');
    await store.remove(key);
  }
  return {
    status: confirm ? 'deleted' : 'planned',
    keys,
    bytes: keys.reduce((n, key) => n + inventory.get(key)!, 0),
    retainedCatalogHash: graph.current.catalogHash,
  };
}
