import { localEntries, verifyLocalReplay, type LocalReplay } from './local-source.ts';

/**
 * Optional browser copy of local replays. GitHub Pages serves other repositories' apps from
 * the same origin, so the database name carries this repository's name and a format version.
 * Browsers may evict it at any time; the exported file remains the backup.
 */
export const LOCAL_DATABASE = 'FantasySimulation/local-replays/v1';
const ENTRIES = 'entries',
  FILES = 'files';
export interface StoredReplay {
  key: string;
  replayId: string;
  outcome: string;
  lastVerifiedStep: number | null;
  bytes: number;
  savedAt: string;
}
interface StoredFiles {
  key: string;
  entries: { name: string; bytes: ArrayBuffer }[];
}
export class LocalStoreError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'quota' | 'missing',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LocalStoreError';
  }
}
const failure = (error: unknown) =>
  error instanceof LocalStoreError
    ? error
    : error instanceof DOMException && error.name === 'QuotaExceededError'
      ? new LocalStoreError('quota', 'Browser storage is full', { cause: error })
      : new LocalStoreError('unavailable', 'Browser storage is unavailable', { cause: error });

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(LOCAL_DATABASE, 1);
    } catch (error) {
      reject(failure(error));
      return;
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore(ENTRIES, { keyPath: 'key' });
      request.result.createObjectStore(FILES, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(failure(request.error));
    request.onblocked = () => reject(new LocalStoreError('unavailable', 'Browser storage is busy'));
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  work: (entries: IDBObjectStore, files: IDBObjectStore) => IDBRequest<T> | undefined,
): Promise<T | undefined> {
  const db = await database();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction([ENTRIES, FILES], mode);
      const request = work(tx.objectStore(ENTRIES), tx.objectStore(FILES));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(failure(tx.error));
      tx.onabort = () => reject(failure(tx.error));
    });
  } finally {
    db.close();
  }
}

export async function listStoredReplays(): Promise<StoredReplay[]> {
  const rows = await transaction<StoredReplay[]>('readonly', (entries) => entries.getAll());
  return (rows ?? []).toSorted((a, b) => b.savedAt.localeCompare(a.savedAt));
}
export async function storeReplay(replay: LocalReplay, now = new Date()): Promise<StoredReplay> {
  const entries = localEntries(replay);
  const row: StoredReplay = {
    key: replay.key,
    replayId: replay.manifest.id,
    outcome:
      replay.manifest.end.kind === 'result'
        ? replay.manifest.end.result.outcome.kind
        : replay.manifest.end.kind,
    lastVerifiedStep: replay.manifest.lastVerifiedStep,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes.length, 0),
    savedAt: now.toISOString(),
  };
  const files: StoredFiles = {
    key: replay.key,
    entries: entries.map((entry) => ({ name: entry.name, bytes: entry.bytes.slice().buffer })),
  };
  await transaction('readwrite', (store, blobs) => {
    blobs.put(files);
    return store.put(row);
  });
  return row;
}
/** Stored bytes are untrusted like any selected file and are verified again before use. */
export async function loadStoredReplay(key: string): Promise<LocalReplay> {
  const stored = await transaction<StoredFiles>('readonly', (_, files) => files.get(key));
  if (!stored) throw new LocalStoreError('missing', 'The saved replay was removed');
  return verifyLocalReplay(
    stored.entries.map((entry) => ({ name: entry.name, bytes: new Uint8Array(entry.bytes) })),
  );
}
export async function deleteStoredReplay(key: string) {
  await transaction('readwrite', (entries, files) => {
    files.delete(key);
    return entries.delete(key);
  });
}
