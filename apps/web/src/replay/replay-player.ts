import {
  canonicalJson,
  compareIds,
  deepFreeze,
  type ReplayCheckpoint,
  type StreamRecord,
  type DisplayState,
  type BattleEvent,
} from '@fantasy/domain/spatial';
import type { OpenedReplay } from './open-replay.ts';
import { toLoadError } from './artifacts.ts';

type ValidatedChunk = { before: ReplayCheckpoint; records: readonly StreamRecord[] };
export type ReplayFrame = {
  checkpoint: ReplayCheckpoint;
  records: readonly StreamRecord[];
  events: readonly BattleEvent[];
};
const recordStep = (r: StreamRecord) => (r.kind === 'interval' ? r.toStep : r.step);
const orderedState = (state: DisplayState): DisplayState => ({
  actors: [...state.actors].sort((a, b) => compareIds(a.id, b.id)),
  projectiles: [...state.projectiles].sort((a, b) => compareIds(a.id, b.id)),
});
function orderedCheckpoint(value: ReplayCheckpoint): ReplayCheckpoint {
  return {
    ...value,
    state: value.state && orderedState(value.state),
    lastRecord:
      value.lastRecord?.kind === 'initial'
        ? { ...value.lastRecord, state: orderedState(value.lastRecord.state) }
        : value.lastRecord,
  };
}

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
        .map((p) => ({ ...p, ...updates.get(p.id) }));
    }
    state = { actors, projectiles };
  }
  return {
    ...before,
    state: orderedState(state!),
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
  private cursor: ReplayFrame | undefined;
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
    // Checkpoint schemas accept entity enumeration differences; continuity compares canonical state.
    const before = orderedCheckpoint(validator.checkpoint());
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
    return (await this.frame(step, signal)).checkpoint;
  }

  async events(index: number, signal?: AbortSignal) {
    const chunk = await this.chunk(index, signal);
    signal?.throwIfAborted();
    return structuredClone(chunk.records.flatMap((r) => ('events' in r ? r.events : [])));
  }

  async frame(step: number, signal?: AbortSignal): Promise<ReplayFrame> {
    const { manifest } = this.replay;
    if (!Number.isSafeInteger(step) || step < 0 || step > (manifest.lastVerifiedStep ?? 0))
      throw new RangeError('Step outside recorded range');
    const request = ++this.request;
    try {
      signal?.throwIfAborted();
      // Start before the requested step so interval/boundary/terminal records at a
      // chunk edge all remain visible. A distant seek never walks the entire prefix.
      const start = Math.max(
        0,
        manifest.chunks.findLastIndex((c) => c.fromStep < step),
      );
      const previous = this.cursor?.checkpoint;
      const previousIndex = manifest.chunks.findLastIndex(
        (c) => previous && c.firstRecord <= previous.nextRecord,
      );
      let cursor =
        previous && previous.step <= step && start <= previousIndex + 1 ? previous : undefined;
      const records: StreamRecord[] = cursor?.step === step ? [...this.cursor!.records] : [];
      let index = Math.max(0, cursor ? previousIndex : start);
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
          if (recordStep(record) > step)
            return this.finish({ checkpoint: cursor, records }, request, signal, record);
          cursor = advance(cursor, record);
          if (recordStep(record) === step) records.push(record);
        }
        index++;
      }
      return this.finish(
        { checkpoint: cursor ?? (await this.replay.seek(0, signal)).checkpoint(), records },
        request,
        signal,
      );
    } catch (error) {
      throw toLoadError(error, 'damaged', signal);
    }
  }

  private finish(
    cursor: Omit<ReplayFrame, 'events'>,
    request: number,
    signal?: AbortSignal,
    next?: StreamRecord,
  ) {
    signal?.throwIfAborted();
    // Interval events keep their own timestamp (some belong to fromStep). Inspect
    // the next verified record without applying its future state or trajectories.
    const events = [...cursor.records, ...(next ? [next] : [])]
      .flatMap((r) => ('events' in r ? r.events : []))
      .filter((event) => event.step === cursor.checkpoint.step);
    const frame = { ...cursor, events };
    if (request === this.request) this.cursor = frame;
    // UI callers own the returned snapshot; mutations cannot poison the verified cache/cursor.
    return structuredClone(frame);
  }
}
