import { ViewerBuildSchema } from '@fantasy/domain';
import {
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
  type PublicationFile,
} from './publication-files.ts';
import { sha256 } from './replay-files.ts';

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
}
export interface PublishOptions {
  viewer(): Promise<unknown>;
  ancestor(source: string, viewer: string): boolean;
  worker(key: string, limit: number): Promise<Buffer>;
  maxBytes?: number;
  maxWrites?: number;
  maxTransferBytes?: number;
  maxWorkerRequests?: number;
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
}
function limit(value: number | undefined, fallback: number, upper: number) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > upper) throw new Error('Invalid publication budget');
  return n;
}
const rank = (key: string) =>
  key.startsWith('objects/')
    ? 0
    : key.startsWith('sets/')
      ? key.endsWith('/set.json')
        ? 2
        : 1
      : 3;
async function exact(store: PublicationStore, file: PublicationFile) {
  const value = await store.read(file.key, file.bytes);
  if (!value || value.data.length !== file.bytes || sha256(value.data) !== file.checksum)
    throw new Error('Immutable publication collision');
  return value;
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
/** Single administrator, sequential upload; S3 conditional writes make pointer replacement atomic. */
export async function publishPublication(
  root: string,
  store: PublicationStore,
  options: PublishOptions,
) {
  let phase: PublicationPhase = 'not-committed';
  try {
    const maxBytes = limit(options.maxBytes, PUBLICATION_MAX_BYTES, PUBLICATION_MAX_BYTES);
    const maxWrites = limit(options.maxWrites, 10000, 100000);
    const maxTransfer = limit(options.maxTransferBytes, 256_000_000, PUBLICATION_MAX_BYTES);
    const maxWorker = limit(options.maxWorkerRequests, 200, 1000);
    const graph = await localPublicationGraph(root);
    const compatible = async () => {
      const viewer = ViewerBuildSchema.parse(await options.viewer());
      for (const source of graph.sources)
        if (!options.ancestor(source, viewer.sourceSha))
          throw new Error('Data source is not an ancestor of the published viewer');
    };
    await compatible();
    const pointer = graph.files.get('catalog/current.json')!;
    const previous = await store.read(pointer.key, 4_000_000);
    const remoteCurrent = previous
      ? PublicCatalogCurrentSchema.parse(JSON.parse(previous.data.toString('utf8')))
      : null;
    const unchanged = previous !== null && sha256(previous.data) === pointer.checksum;
    if (unchanged) phase = 'committed-unverified';
    if (!unchanged && graph.catalog.previousCatalogHash !== (remoteCurrent?.catalogHash ?? null))
      throw new Error('Publication generation changed');
    let priorSets = new Set<string>();
    if (remoteCurrent) {
      const old = await exact(store, {
        key: `catalog/${publicHashName(remoteCurrent.catalogHash)}.json`,
        bytes: remoteCurrent.bytes,
        checksum: remoteCurrent.catalogHash,
      });
      priorSets = new Set(
        PublicCatalogSchema.parse(JSON.parse(old.data.toString('utf8'))).sets.map((s) => s.setHash),
      );
    }
    const inventory = await store.inventory();
    const resultHashes = new Map(graph.results);
    for (const key of inventory.keys())
      if (key.endsWith('/receipt.json')) {
        const value = await store.read(key, 65536);
        if (!value) throw new Error('Remote receipt disappeared');
        receiptIdentity(key, value.data, resultHashes);
      }
    const additions: PublicationFile[] = [];
    for (const file of graph.files.values())
      if (file.key !== pointer.key) {
        if (inventory.has(file.key)) await exact(store, file);
        else additions.push(file);
      }
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
    if (sample)
      for (const key of graph.files.keys())
        if (key.startsWith(`objects/${publicHashName(sample)}/`)) selected.add(key);
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
      workerRequests: selected.size,
      // Includes every HEAD/generation check and a recovery GET for each uncertain PUT.
      // The store has already charged inventory pages, receipt and collision reads.
      reservedS3Requests: additions.length * 2 + graph.files.size + 3 + (unchanged ? 0 : 2),
      incompleteRows: [...graph.sets.values()].reduce((n, set) => n + set.incompleteRows, 0),
    };
    options.observe?.(report);
    if (
      report.projectedBytes > maxBytes ||
      report.writes > maxWrites ||
      report.transferBytes > maxTransfer ||
      report.reservedS3Requests > store.remainingRequests() ||
      inventory.size + additions.length + (previous ? 0 : 1) > PUBLICATION_MAX_FILES ||
      selected.size > maxWorker
    )
      throw new Error('Publication capacity/request budget exceeded before writing');
    if (options.dryRun) return { status: 'planned' as const, ...report };
    const sameGeneration = async () => {
      const now = await store.read(pointer.key, 4_000_000);
      if (
        (previous === null) !== (now === null) ||
        (previous && (!now || now.etag !== previous.etag || !now.data.equals(previous.data)))
      )
        throw new Error('Publication generation changed');
    };
    await sameGeneration();
    for (const file of additions.sort(
      (a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key),
    )) {
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
    }
    // All referenced immutable objects must be present before committing current.json.
    for (const file of graph.files.values())
      if (file.key !== pointer.key && (await store.head(file.key)) !== file.bytes)
        throw new Error('S3 size verification failed');
    await compatible();
    await sameGeneration();
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
      throw new Error('S3 pointer verification failed');
    for (const key of selected) {
      const file = graph.files.get(key)!,
        data = await options.worker(key, file.bytes);
      if (data.length !== file.bytes || sha256(data) !== file.checksum)
        throw new Error('Worker read-back checksum mismatch');
    }
    return { status: 'verified' as const, ...report };
  } catch (error) {
    throw new PublicationFailure(phase, error);
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
  const keys = [...inventory.keys()].filter((key) => !graph.files.has(key));
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
