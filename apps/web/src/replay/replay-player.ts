import {
  canonicalJson,
  compareIds,
  deepFreeze,
  type ReplayCheckpoint,
  type StreamRecord,
} from '@fantasy/domain/spatial';
import type { OpenedReplay } from './open-replay.ts';
import { toLoadError } from './artifacts.ts';

type ValidatedChunk = { before: ReplayCheckpoint; records: readonly StreamRecord[] };
const recordStep = (r: StreamRecord) => (r.kind === 'interval' ? r.toStep : r.step);

/** Private projection: callers cannot supply records or bypass the existing validator. */
function advance(before: ReplayCheckpoint, record: StreamRecord): ReplayCheckpoint {
  let state = before.state;
  if (record.kind === 'initial') state = record.state;
  else if (record.kind !== 'terminal') {
    const changes = new Map(record.changes.map((delta) => [delta.id, delta]));
    const actors = state!.actors.map((actor) => Object.assign({ ...actor }, changes.get(actor.id)));
    let projectiles = state!.projectiles;
    if (record.kind === 'interval') {
      const updates = new Map(record.projectiles.update.map((delta) => [delta.id, delta]));
      const removed = new Set(record.projectiles.remove.map((delta) => delta.id));
      projectiles = [...projectiles, ...record.projectiles.spawn]
        .filter((p) => !removed.has(p.id))
        .map((p) => ({ ...p, ...updates.get(p.id) }))
        .sort((a, b) => compareIds(a.id, b.id));
    }
    state = { actors, projectiles };
  }
  // Initial actors are normalized by the validator; preserve its canonical entity order.
  if (record.kind === 'initial')
    state = {
      ...record.state,
      actors: [...record.state.actors].sort((a, b) => compareIds(a.id, b.id)),
    };
  return {
    ...before,
    state,
    step: recordStep(record),
    nextRecord: before.nextRecord + 1,
    nextEvent: before.nextEvent + ('events' in record ? record.events.length : 0),
    boundaryApplied:
      record.kind === 'boundary' || (record.kind === 'terminal' && before.boundaryApplied),
    lastRecord: record,
  };
}

/** Validate each loaded chunk once, retain at most two, then advance only new deltas. */
export class ReplayPlayer {
  private readonly chunks = new Map<number, ValidatedChunk>();
  private cursor: ReplayCheckpoint | undefined;
  private request = 0;
  constructor(private readonly replay: OpenedReplay) {}

  private async chunk(index: number, signal?: AbortSignal): Promise<ValidatedChunk> {
    const hit = this.chunks.get(index);
    if (hit) {
      this.chunks.delete(index);
      this.chunks.set(index, hit);
      return hit;
    }
    const ref = this.replay.manifest.chunks[index]!;
    const validator = await this.replay.seek(ref.firstRecord, signal);
    const before = validator.checkpoint();
    const raw = await this.replay.records(index, signal);
    if (raw.length !== ref.records) throw new Error('Replay chunk record count');
    const records = raw.map((value) => {
      signal?.throwIfAborted();
      return validator.apply(value);
    });
    if (validator.nextRecord !== ref.firstRecord + ref.records || validator.step !== ref.toStep)
      throw new Error('Replay chunk range');
    signal?.throwIfAborted();
    const chunk: ValidatedChunk = { before, records };
    deepFreeze(chunk);
    this.chunks.set(index, chunk);
    while (this.chunks.size > 2) this.chunks.delete(this.chunks.keys().next().value!);
    return chunk;
  }

  async seek(step: number, signal?: AbortSignal): Promise<ReplayCheckpoint> {
    const { manifest } = this.replay;
    if (!Number.isSafeInteger(step) || step < 0 || step > (manifest.lastVerifiedStep ?? 0))
      throw new RangeError('Step outside recorded range');
    const request = ++this.request;
    try {
      signal?.throwIfAborted();
      let cursor = this.cursor && this.cursor.step <= step ? this.cursor : undefined;
      let index = Math.max(
        0,
        manifest.chunks.findLastIndex((chunk) =>
          cursor ? chunk.firstRecord <= cursor.nextRecord : chunk.fromStep <= step,
        ),
      );
      while (index < manifest.chunks.length) {
        const chunk = await this.chunk(index, signal),
          ref = manifest.chunks[index]!;
        if (!cursor) cursor = chunk.before;
        else if (
          cursor.nextRecord === ref.firstRecord &&
          canonicalJson(cursor) !== canonicalJson(chunk.before)
        )
          throw new Error('Replay checkpoint continuity');
        for (const record of chunk.records.slice(cursor.nextRecord - ref.firstRecord)) {
          if (recordStep(record) > step) return this.finish(cursor, request, signal);
          cursor = advance(cursor, record);
        }
        index++;
      }
      return this.finish(
        cursor ?? (await this.replay.seek(0, signal)).checkpoint(),
        request,
        signal,
      );
    } catch (error) {
      throw toLoadError(error, 'damaged', signal);
    }
  }

  private finish(cursor: ReplayCheckpoint, request: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (request === this.request) this.cursor = cursor;
    // UI callers own the returned snapshot; mutations cannot poison the verified cache/cursor.
    return structuredClone(cursor);
  }
}
