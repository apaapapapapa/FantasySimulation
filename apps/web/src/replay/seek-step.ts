import { ReplayState } from '@fantasy/domain/spatial';
import type { OpenedReplay } from './open-replay.ts';

/** Display the final recorded state at this step, including its boundary/terminal records. */
export async function seekStep(replay: OpenedReplay, step: number, signal?: AbortSignal) {
  const last = replay.manifest.lastVerifiedStep ?? 0;
  if (!Number.isSafeInteger(step) || step < 0 || step > last)
    throw new RangeError('Step outside recorded range');
  const chunks = replay.manifest.chunks;
  const start = Math.max(
    0,
    chunks.findLastIndex((chunk) => chunk.fromStep <= step),
  );
  const state = await replay.seek(chunks[start]?.firstRecord ?? 0, signal);
  for (let index = start; index < chunks.length; index++) {
    for (const raw of await replay.records(index, signal)) {
      signal?.throwIfAborted();
      const before = state.checkpoint();
      state.apply(raw);
      if (state.step > step) return new ReplayState(replay.context, before);
    }
  }
  return state;
}
