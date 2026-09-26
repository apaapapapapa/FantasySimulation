import {
  hashBytes,
  MAX_PUBLIC_JSON_BYTES,
  MAX_REPLAY_MANIFEST_BYTES,
  RECORDING_PROFILE,
  type ReplayManifest,
} from '@fantasy/domain/spatial';
import { ReplayLoadError, strictText, toLoadError } from './artifacts.ts';
import { parseSavedManifest, type ReplaySource } from './open-replay.ts';
import { readTar, tarBytes, writeTar, type TarEntry } from './tar.ts';

/** One replay's files as written by ReplayWriter/exported publication; no other format. */
export const LOCAL_MANIFEST = 'manifest.json';
/** Public bundles carry a receipt next to the manifest. It is not an attestation; it is ignored. */
const RECEIPT = 'receipt.json';
const ARTIFACT = /^(chunk|checkpoint)-[0-9]{5}\.(ndjson|json)\.gz$/;
const MAX_ARTIFACTS = 2 * 12002;
export const LOCAL_MAX_FILES = MAX_ARTIFACTS + 2;
/** The #79 manifest and stored-byte limits, plus an ignorable public receipt. */
export const LOCAL_MAX_BYTES =
  MAX_REPLAY_MANIFEST_BYTES + RECORDING_PROFILE.maxStoredBytes + MAX_PUBLIC_JSON_BYTES;
const MAX_TAR_BYTES =
  LOCAL_MAX_BYTES +
  tarBytes(Array.from({ length: LOCAL_MAX_FILES }, () => ({ name: '', bytes: 0 })));

export interface LocalReplay {
  readonly key: string;
  readonly manifest: ReplayManifest;
  readonly manifestBytes: Uint8Array<ArrayBuffer>;
  /** Exactly the manifest's chunks and checkpoints, each size/checksum verified. */
  readonly files: Readonly<Record<string, Uint8Array<ArrayBuffer>>>;
}
export interface LocalFile {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
const baseName = (name: string) => name.slice(name.lastIndexOf('/') + 1);
function limitFor(name: string) {
  if (name === LOCAL_MANIFEST) return MAX_REPLAY_MANIFEST_BYTES;
  if (name === RECEIPT) return MAX_PUBLIC_JSON_BYTES;
  if (ARTIFACT.test(name)) return RECORDING_PROFILE.maxStoredBytes;
  if (name.endsWith('.tar')) return MAX_TAR_BYTES;
  throw new ReplayLoadError('damaged', `Unexpected replay file: ${name}`);
}

/**
 * Read files chosen by the viewer. Sizes are checked before any bytes are read, so an
 * oversized selection is rejected without loading it. Nothing is sent anywhere.
 */
export async function readLocalFiles(files: readonly LocalFile[]): Promise<LocalReplay> {
  if (!files.length) throw new ReplayLoadError('damaged', 'No replay files were selected');
  if (files.length > LOCAL_MAX_FILES)
    throw new ReplayLoadError('damaged', 'Too many files for one replay');
  let total = 0;
  for (const file of files) {
    total += file.size;
    if (file.size > limitFor(baseName(file.name)))
      throw new ReplayLoadError('damaged', `${file.name} exceeds its size limit`);
  }
  const archive = files.length === 1 && files[0]!.name.endsWith('.tar');
  if (total > (archive ? MAX_TAR_BYTES : LOCAL_MAX_BYTES))
    throw new ReplayLoadError('damaged', 'Selected files exceed the replay size limit');
  const read = async (file: LocalFile) => new Uint8Array(await file.arrayBuffer());
  if (archive) return verifyLocalReplay(readTar(await read(files[0]!), LOCAL_MAX_FILES));
  return verifyLocalReplay(
    await Promise.all(files.map(async (file) => ({ name: file.name, bytes: await read(file) }))),
  );
}

/** Apply the #79 bytes contract to a set of named files (also used for stored copies). */
export async function verifyLocalReplay(entries: readonly TarEntry[]): Promise<LocalReplay> {
  try {
    const named = new Map<string, Uint8Array<ArrayBuffer>>();
    let total = 0;
    for (const entry of entries) {
      const name = baseName(entry.name);
      if (named.has(name)) throw new ReplayLoadError('damaged', `Duplicate replay file: ${name}`);
      if (entry.bytes.length > limitFor(name) || name.endsWith('.tar'))
        throw new ReplayLoadError('damaged', `Unexpected replay file: ${name}`);
      total += entry.bytes.length;
      named.set(name, entry.bytes);
    }
    if (total > LOCAL_MAX_BYTES)
      throw new ReplayLoadError('damaged', 'Replay files exceed the size limit');
    const manifestBytes = named.get(LOCAL_MANIFEST);
    if (!manifestBytes) throw new ReplayLoadError('damaged', 'manifest.json is missing');
    const manifest = parseSavedManifest(JSON.parse(strictText(manifestBytes, LOCAL_MANIFEST)));
    const refs = [...manifest.chunks, ...manifest.checkpoints];
    const expected = new Set([LOCAL_MANIFEST, RECEIPT, ...refs.map((ref) => ref.file)]);
    const extra = [...named.keys()].find((name) => !expected.has(name));
    if (extra) throw new ReplayLoadError('damaged', `File is not in the manifest: ${extra}`);
    const files: Record<string, Uint8Array<ArrayBuffer>> = {};
    for (const ref of refs) {
      const bytes = named.get(ref.file);
      if (!bytes) throw new ReplayLoadError('damaged', `Replay file is missing: ${ref.file}`);
      if (bytes.length !== ref.bytes || (await hashBytes(bytes)) !== ref.checksum)
        throw new ReplayLoadError('damaged', `${ref.file} does not match its size and checksum`);
      files[ref.file] = bytes;
    }
    return { key: await hashBytes(manifestBytes), manifest, manifestBytes, files };
  } catch (error) {
    throw toLoadError(error, 'damaged');
  }
}

/** The replay's own files, unchanged, in manifest order. */
export const localEntries = (replay: Pick<LocalReplay, 'manifest' | 'manifestBytes' | 'files'>) => [
  { name: LOCAL_MANIFEST, bytes: replay.manifestBytes },
  ...[...replay.manifest.chunks, ...replay.manifest.checkpoints].map((ref) => ({
    name: ref.file,
    bytes: replay.files[ref.file]!,
  })),
];
export const exportLocalReplay = (replay: LocalReplay) => writeTar(localEntries(replay));

/** In-memory transport; openReplay still verifies each file when it is used. */
export function localReplaySource(
  replay: Pick<LocalReplay, 'manifestBytes' | 'files'>,
): ReplaySource {
  return {
    location: { mode: 'local', manifest: replay.manifestBytes, files: replay.files },
    manifest: () =>
      Promise.resolve().then((): unknown =>
        JSON.parse(strictText(replay.manifestBytes, LOCAL_MANIFEST)),
      ),
    file: (ref) => {
      const bytes = replay.files[ref.file];
      return bytes
        ? Promise.resolve(bytes)
        : Promise.reject(new ReplayLoadError('damaged', `Replay file is missing: ${ref.file}`));
    },
  };
}
