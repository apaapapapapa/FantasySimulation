import { IdSchema, MAX_REPLAY_MANIFEST_BYTES, type ArtifactRef } from '@fantasy/domain/spatial';
import { readBounded, ReplayLoadError, strictText, toLoadError } from './artifacts.ts';
import type { ReplaySource } from './open-replay.ts';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/**
 * Local development adapter for `GET /api/replays/:id` and `/files/:file`. The API answers
 * 404/503 for unknown or held (missing, corrupt, quarantined) artifacts; other failures are
 * delivery errors. Public static builds must not use it; they read the published layout (#81).
 */
export function apiReplaySource(
  id: string,
  options: { base?: string; fetch?: Fetch } = {},
): ReplaySource {
  if (!IdSchema.safeParse(id).success) throw new ReplayLoadError('damaged', 'Invalid replay ID');
  const request: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const root = `${options.base ?? ''}/api/replays/${encodeURIComponent(id)}`;
  async function get(url: string, type: string, limit: number, signal?: AbortSignal) {
    try {
      const response = await request(url, { signal: signal ?? null, headers: { accept: type } });
      if (!response.ok) {
        await response.body?.cancel();
        const held = response.status === 404 || response.status === 503;
        throw new ReplayLoadError(
          held ? 'damaged' : response.status === 429 ? 'limit' : 'unavailable',
          `Replay API responded ${response.status}`,
        );
      }
      const received = response.headers.get('content-type') ?? '';
      // Transparent content decoding would change the bytes that the checksum covers.
      if (
        !received.startsWith(type) ||
        (type === 'application/gzip' && response.headers.has('content-encoding'))
      ) {
        await response.body?.cancel();
        throw new ReplayLoadError('unavailable', `Unexpected replay response: ${received}`);
      }
      return await readBounded(response.body ?? new Blob().stream(), limit, url);
    } catch (error) {
      throw toLoadError(error, 'unavailable', signal);
    }
  }
  return {
    async manifest(signal) {
      const bytes = await get(root, 'application/json', MAX_REPLAY_MANIFEST_BYTES, signal);
      let value: unknown;
      try {
        value = JSON.parse(strictText(bytes, 'Replay manifest'));
      } catch (error) {
        throw toLoadError(error, 'damaged');
      }
      if (typeof value !== 'object' || value === null || !('id' in value) || value.id !== id)
        throw new ReplayLoadError('damaged', 'Replay manifest does not match the requested ID');
      return value;
    },
    file: (ref: ArtifactRef, signal?: AbortSignal) =>
      get(`${root}/files/${encodeURIComponent(ref.file)}`, 'application/gzip', ref.bytes, signal),
  };
}
