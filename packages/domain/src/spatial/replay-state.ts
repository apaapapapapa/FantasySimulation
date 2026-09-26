import { validateSpatialObject, applySpatialObjects } from './replay-validation/spatial-object.ts';
import { compareIds } from './canonical.ts';
import { parseJson } from './contracts.ts';
import type { Outcome } from './records.ts';
import { initialResources } from './resources.ts';
import { ReplayCheckpointSchema, type ReplayCheckpoint, type ReplayManifest } from './replay.ts';
import {
  StreamRecordSchema,
  type DisplayPath,
  type DisplayState,
  type StreamRecord,
} from './stream.ts';
import { fail, requireReplay, same } from './replay-validation/common.ts';
import type { ReplayContext } from './replay-validation/context.ts';
export { replayContext, type ReplayContext } from './replay-validation/context.ts';
import { validateReactions } from './replay-validation/reaction.ts';
import { validateForces } from './replay-validation/force.ts';
import { validateAction } from './replay-validation/action.ts';
import { validateProjectile } from './replay-validation/projectile.ts';
import { validateEvents } from './replay-validation/event.ts';
import { validateInterferences } from './replay-validation/interference.ts';

/** Atomic display restoration. This is not an engine resume snapshot or combat re-simulation. */
export class ReplayState {
  readonly context: ReplayContext;
  private value: ReplayCheckpoint;
  constructor(context: ReplayContext, checkpoint?: unknown) {
    this.context = context;
    this.value =
      checkpoint === undefined
        ? {
            schemaVersion: 1,
            simulationHash: context.simulationHash,
            step: 0,
            nextRecord: 0,
            nextEvent: 0,
            boundaryApplied: false,
            state: null,
            lastRecord: null,
          }
        : parseJson(ReplayCheckpointSchema, checkpoint);
    const v = this.value;
    requireReplay(
      v.simulationHash === context.simulationHash && v.step <= context.rules.maxSteps,
      'checkpoint binding/range',
    );
    if (v.state === null)
      requireReplay(
        v.nextRecord === 0 &&
          v.nextEvent === 0 &&
          v.step === 0 &&
          v.lastRecord === null &&
          !v.boundaryApplied,
        'empty checkpoint',
      );
    else {
      requireReplay(v.nextRecord > 0 && v.lastRecord !== null, 'checkpoint cursor');
      this.validateState(v.state, v.step);
      const last = v.lastRecord!;
      requireReplay(
        v.nextRecord >= v.step + 1 && v.nextRecord <= 2 * v.step + 3,
        'checkpoint record cursor',
      );
      if (last.kind !== 'terminal')
        requireReplay(v.boundaryApplied === (last.kind === 'boundary'), 'checkpoint boundary');
      requireReplay(
        (last.kind === 'interval' ? last.toStep : last.step) === v.step,
        'checkpoint step',
      );
      if ('events' in last)
        requireReplay(
          last.events.every((e, i) => e.sequence === v.nextEvent - last.events.length + i),
          'checkpoint event cursor',
        );
      else
        requireReplay(
          v.nextRecord === 1 && v.nextEvent === 0 && same(v.state, last.state),
          'initial checkpoint',
        );
      if (last.kind === 'terminal')
        this.validateOutcome(last.outcome, v.state, v.step, v.nextEvent - last.events.length);
    }
  }
  checkpoint(): ReplayCheckpoint {
    return structuredClone(this.value);
  }
  get step() {
    return this.value.step;
  }
  get nextRecord() {
    return this.value.nextRecord;
  }
  get ended() {
    return this.value.lastRecord?.kind === 'terminal';
  }
  private validateState(state: DisplayState, step: number, nextEvent = this.value.nextEvent) {
    requireReplay(new Set(state.actors.map((a) => a.id)).size === 2, 'actor IDs');
    for (const actor of state.actors) {
      const definition = this.context.actors.find((a) => a.participant.actorId === actor.id);
      if (!definition) return fail('unknown actor');
      validateReactions(this.context, actor, definition, step, nextEvent);
      validateForces(this.context, actor, step);
      requireReplay(
        actor.resources.hp <= definition.character.stats.hp &&
          actor.resources.mp <= definition.character.stats.mp &&
          (definition.character.stamina
            ? actor.resources.stamina !== undefined &&
              actor.resources.stamina <= definition.character.stamina.max
            : actor.resources.stamina === undefined),
        'actor resource range',
      );
      for (const status of actor.statuses) {
        const r = this.context.manifest.revisions.find(
          (r) =>
            r.kind === 'status' &&
            r.id === status.revision.id &&
            r.revision === status.revision.revision &&
            r.contentHash === status.revision.contentHash,
        );
        requireReplay(
          !!r && status.startStep <= step && status.startStep < status.endStep,
          'status reference/time',
        );
      }
      validateAction(actor, definition, step);
    }
    const ids = new Set(state.actors.map((a) => a.id));
    for (const object of state.objects ?? []) {
      requireReplay(!ids.has(object.id), 'duplicate entity');
      ids.add(object.id);
      validateSpatialObject(this.context, object, step);
    }
    for (const p of state.projectiles) {
      requireReplay(!ids.has(p.id), 'duplicate entity');
      ids.add(p.id);
      validateProjectile(this.context, p, step);
    }
  }
  private validateOutcome(
    outcome: Outcome,
    state: DisplayState,
    step: number,
    nextEvent = this.value.nextEvent,
  ) {
    validateInterferences(this.context, outcome, step, nextEvent);
    if (outcome.kind === 'win')
      requireReplay(
        state.actors.some((a) => a.id === outcome.winner && a.resources.hp > 0) &&
          state.actors.some((a) => a.id !== outcome.winner && a.resources.hp === 0),
        'winner/final state',
      );
    else if (outcome.kind === 'draw')
      requireReplay(
        outcome.reason === 'mutual-defeat'
          ? state.actors.every((a) => a.resources.hp === 0)
          : step === this.context.rules.maxSteps && state.actors.every((a) => a.resources.hp > 0),
        'draw/final state',
      );
  }
  private paths(
    paths: DisplayPath[],
    before: Map<string, { x: number; y: number; z: number }>,
    after: Map<string, { x: number; y: number; z: number }>,
    ends: Map<string, number>,
  ) {
    requireReplay(paths.length === before.size, 'missing entity path');
    const seen = new Set<string>();
    for (const path of paths) {
      const start = before.get(path.entityId),
        end = after.get(path.entityId);
      requireReplay(!!start && !seen.has(path.entityId), 'unknown/duplicate path');
      seen.add(path.entityId);
      const first = path.segments[0]!,
        last = path.segments.at(-1)!;
      requireReplay(
        first.from === 0 && same(first.start, start) && (end === undefined || same(last.end, end)),
        'path endpoint',
      );
      requireReplay(
        Math.abs(last.to - (ends.get(path.entityId) ?? 1)) <= 0.00000051,
        'path time coverage',
      );
      for (let i = 1; i < path.segments.length; i++) {
        const a = path.segments[i - 1]!,
          b = path.segments[i]!;
        requireReplay(
          Math.abs(a.to - b.from) <= 1e-12 && same(a.end, b.start),
          'path discontinuity',
        );
      }
    }
  }
  apply(input: unknown): StreamRecord {
    const record = parseJson(StreamRecordSchema, input),
      prior = this.value;
    requireReplay(!this.ended && prior.nextRecord < 12002, 'record after terminal/limit');
    let state: DisplayState,
      step = prior.step,
      boundaryApplied = prior.boundaryApplied;
    if (record.kind === 'initial') {
      requireReplay(
        prior.state === null &&
          record.state.projectiles.length === 0 &&
          !record.state.objects?.length,
        'duplicate/nonempty initial',
      );
      state = record.state;
      for (const actor of state.actors) {
        const p = this.context.manifest.participants.find((p) => p.actorId === actor.id);
        requireReplay(
          !!p &&
            same(actor.position, {
              x: p!.position.x / 1000,
              y: p!.position.y / 1000,
              z: p!.position.z / 1000,
            }),
          'initial position',
        );
        const definition = this.context.actors.find((a) => a.participant.actorId === actor.id)!;
        requireReplay(
          same(actor.resources, initialResources(definition.character)) &&
            (!actor.locomotion ||
              same(actor.locomotion, { mode: 'idle', jumping: false, dodging: false })) &&
            same(actor.velocity, { x: 0, y: 0, z: 0 }) &&
            actor.statuses.length === 0 &&
            actor.action === null,
          'initial display state',
        );
      }
    } else {
      if (!prior.state) return fail('missing initial');
      state = structuredClone(prior.state);
      const entities = new Set(
        [...state.actors, ...state.projectiles, ...(state.objects ?? [])].map((e) => e.id),
      );
      if (record.kind === 'terminal') {
        requireReplay(record.step === step, 'terminal step');
        this.validateOutcome(record.outcome, state, step);
        const reason =
          record.outcome.kind === 'win' ? record.outcome.winner : record.outcome.reason;
        requireReplay(
          record.events[0]!.ruleId === `battle.${record.outcome.kind}` &&
            record.events[0]!.reason === reason,
          'terminal outcome event',
        );
      } else {
        if (record.kind === 'boundary') {
          requireReplay(record.step === step && !boundaryApplied, 'duplicate/misplaced boundary');
          boundaryApplied = true;
        } else {
          requireReplay(
            record.fromStep === step && record.toStep <= this.context.rules.maxSteps,
            'interval gap/range',
          );
          step = record.toStep;
          boundaryApplied = false;
        }
        if (record.objects)
          applySpatialObjects(this.context, prior, state, record.objects, record, entities);
        const changed = new Set<string>();
        for (const delta of record.changes) {
          const index = state.actors.findIndex((a) => a.id === delta.id);
          requireReplay(index >= 0 && !changed.has(delta.id), 'actor delta reference');
          changed.add(delta.id);
          Object.assign(state.actors[index]!, delta);
        }
        if (record.kind === 'interval') {
          const before = new Map(
            [...prior.state.actors, ...prior.state.projectiles].map((e) => [e.id, e.position]),
          );
          for (const p of record.projectiles.spawn) {
            validateProjectile(this.context, p, prior.step);
            requireReplay(!entities.has(p.id) && p.launchStep === prior.step, 'projectile spawn');
            entities.add(p.id);
            before.set(p.id, p.position);
            state.projectiles.push(p);
          }
          const removed = new Map(
            record.projectiles.remove.map((p) => [p.id, p.subtimeMicros / 1_000_000]),
          );
          requireReplay(removed.size === record.projectiles.remove.length, 'duplicate removal');
          const updated = new Set<string>();
          for (const p of record.projectiles.update) {
            const index = state.projectiles.findIndex((x) => x.id === p.id);
            requireReplay(
              index >= 0 && !removed.has(p.id) && !updated.has(p.id),
              'projectile update',
            );
            updated.add(p.id);
            state.projectiles[index] = { ...state.projectiles[index]!, ...p };
          }
          for (const id of removed.keys())
            requireReplay(
              state.projectiles.some((p) => p.id === id),
              'projectile removal',
            );
          for (const p of state.projectiles)
            requireReplay(removed.has(p.id) || updated.has(p.id), 'missing projectile update');
          state.projectiles = state.projectiles.filter((p) => !removed.has(p.id));
          const after = new Map(
            [...state.actors, ...state.projectiles].map((e) => [e.id, e.position]),
          );
          this.paths(record.paths, before, after, removed);
        }
      }
      validateEvents(this.context, this.value, record, entities);
    }
    this.validateState(
      state,
      step,
      prior.nextEvent + ('events' in record ? record.events.length : 0),
    );
    state.actors.sort((a, b) => compareIds(a.id, b.id));
    state.projectiles.sort((a, b) => compareIds(a.id, b.id));
    state.objects?.sort((a, b) => compareIds(a.id, b.id));
    this.value = {
      schemaVersion: 1,
      simulationHash: prior.simulationHash,
      step,
      nextRecord: prior.nextRecord + 1,
      nextEvent: prior.nextEvent + ('events' in record ? record.events.length : 0),
      boundaryApplied,
      state,
      lastRecord: record,
    };
    return structuredClone(record);
  }
}
/** Loads one independent checkpoint/chunk; the caller owns transport, sizes and checksums. */
export interface ReplaySeekSource {
  checkpoint(index: number): Promise<unknown>;
  records(index: number): Promise<readonly unknown[]>;
}
/**
 * Restore the display state after `nextRecord` records, shared by the API and browser readers.
 * The same step before and after its boundary record is distinguished by the record cursor.
 */
export async function seekReplayState(
  context: ReplayContext,
  manifest: ReplayManifest,
  nextRecord: number,
  source: ReplaySeekSource,
): Promise<ReplayState> {
  requireReplay(manifest.simulationHash === context.simulationHash, 'seek manifest binding');
  requireReplay(
    Number.isSafeInteger(nextRecord) && nextRecord >= 0 && nextRecord <= manifest.records,
    'seek cursor',
  );
  const index = manifest.chunks.findLastIndex((chunk) => chunk.firstRecord <= nextRecord);
  // Without chunks the manifest records nothing, so only the empty cursor 0 is valid.
  if (index < 0) return new ReplayState(context);
  const chunk = manifest.chunks[index]!;
  const replay = new ReplayState(context, await source.checkpoint(index));
  requireReplay(
    replay.nextRecord === chunk.firstRecord && replay.step === chunk.fromStep,
    'seek checkpoint index',
  );
  if (nextRecord > chunk.firstRecord) {
    const records = await source.records(index);
    requireReplay(records.length === chunk.records, 'seek chunk record count');
    for (const record of records.slice(0, nextRecord - chunk.firstRecord)) replay.apply(record);
  }
  return replay;
}
