import {
  deepFreeze,
  RECORDING_PROFILE,
  ReplayManifestSchema,
  replayChunkRecords,
  replayContext,
  seekReplayState,
  StoredManifestSchema,
  type ArtifactRef,
  type ReplayContext,
  type ReplayManifest,
  type ReplayState,
} from '@fantasy/domain/spatial';
import {
  expandArtifact,
  ReplayLoadError,
  toLoadError,
  type ReplayLoadErrorKind,
} from './artifacts.ts';

/** Transport only (local API now, static layout of #81 later); the loader verifies all bytes. */
export interface ReplaySource {
  manifest(signal?: AbortSignal): Promise<unknown>;
  file(ref: ArtifactRef, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
}
/** Saved formats this viewer reads, taken from the domain schemas it is built with. */
export const SUPPORTED_REPLAY_FORMAT = Object.freeze({
  manifestSchema: ReplayManifestSchema.shape.schemaVersion.value,
  inputSchema: StoredManifestSchema.shape.schemaVersion.value,
  eventSchema: StoredManifestSchema.shape.eventSchemaVersion.value,
  replaySchema: StoredManifestSchema.shape.replaySchemaVersion.value,
  profile: RECORDING_PROFILE.id,
});
export interface OpenedReplay {
  readonly manifest: ReplayManifest;
  readonly context: ReplayContext;
  /** Parsed records of one chunk, for playing forward after a seek. */
  records(index: number, signal?: AbortSignal): Promise<readonly unknown[]>;
  /** Display state after `nextRecord` records; fetches only that checkpoint and chunk. */
  seek(nextRecord: number, signal?: AbortSignal): Promise<ReplayState>;
}
const object = (value: unknown) =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
/** Name a present but different version; absent fields are left to schema validation. */
function unsupportedFormat(value: unknown): string | null {
  const manifest = object(value),
    input = object(manifest?.input);
  const found: Record<keyof typeof SUPPORTED_REPLAY_FORMAT, unknown> = {
    manifestSchema: manifest?.schemaVersion,
    inputSchema: input?.schemaVersion,
    eventSchema: input?.eventSchemaVersion,
    replaySchema: input?.replaySchemaVersion,
    profile: object(manifest?.profile)?.id,
  };
  for (const [key, supported] of Object.entries(SUPPORTED_REPLAY_FORMAT)) {
    const actual = found[key as keyof typeof found];
    if (actual !== undefined && actual !== supported) return `${key} ${JSON.stringify(actual)}`;
  }
  return null;
}
async function guarded<T>(
  signal: AbortSignal | undefined,
  fallback: ReplayLoadErrorKind,
  work: () => Promise<T>,
): Promise<T> {
  try {
    signal?.throwIfAborted();
    const value = await work();
    // A cancelled request never delivers a late result to the caller.
    signal?.throwIfAborted();
    return value;
  } catch (error) {
    throw toLoadError(error, fallback, signal);
  }
}
/**
 * Open a saved replay without any engine, physics, API or database execution. Verified,
 * decoded files are kept in a small LRU; in-flight requests are never shared across calls.
 */
export async function openReplay(
  source: ReplaySource,
  options: { signal?: AbortSignal; cachedFiles?: number } = {},
): Promise<OpenedReplay> {
  const { signal } = options,
    limit = options.cachedFiles ?? 8;
  const raw = await guarded(signal, 'unavailable', () => source.manifest(signal));
  const unsupported = unsupportedFormat(raw);
  if (unsupported)
    throw new ReplayLoadError('unsupported', `Unsupported replay format: ${unsupported}`);
  const { manifest, context } = await guarded(signal, 'damaged', async () => {
    const parsed = ReplayManifestSchema.safeParse(raw);
    if (!parsed.success)
      throw new ReplayLoadError('damaged', 'Replay manifest is invalid', { cause: parsed.error });
    return {
      manifest: parsed.data,
      context: await replayContext(parsed.data.input, parsed.data.simulationHash),
    };
  });
  const cache = new Map<string, unknown>();
  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (cache.has(key)) {
      const value = cache.get(key) as T;
      cache.delete(key);
      cache.set(key, value);
      return value;
    }
    const value = await load();
    cache.set(key, value);
    for (const oldest of cache.keys()) {
      if (cache.size <= limit) break;
      cache.delete(oldest);
    }
    return value;
  }
  const expand = async (ref: ArtifactRef, requestSignal?: AbortSignal) =>
    expandArtifact(await source.file(ref, requestSignal), ref);
  // Out-of-range indexes and cursors are caller bugs (RangeError), not damaged data.
  async function records(index: number, requestSignal?: AbortSignal) {
    const ref = manifest.chunks[index];
    if (!ref) throw new RangeError(`Replay chunk ${index} does not exist`);
    return guarded(requestSignal, 'damaged', () =>
      cached(`chunk ${index}`, async () =>
        deepFreeze(replayChunkRecords(await expand(ref, requestSignal), ref)),
      ),
    );
  }
  async function seek(nextRecord: number, requestSignal?: AbortSignal) {
    if (!Number.isSafeInteger(nextRecord) || nextRecord < 0 || nextRecord > manifest.records)
      throw new RangeError(`Replay cursor ${nextRecord} is outside 0..${manifest.records}`);
    return guarded(requestSignal, 'damaged', () =>
      seekReplayState(context, manifest, nextRecord, {
        checkpoint: (index) =>
          cached(`checkpoint ${index}`, async () =>
            deepFreeze(
              JSON.parse(await expand(manifest.checkpoints[index]!, requestSignal)) as unknown,
            ),
          ),
        records: (index) => records(index, requestSignal),
      }),
    );
  }
  return { manifest, context, records, seek };
}
