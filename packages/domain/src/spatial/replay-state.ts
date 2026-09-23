import {
  canonicalJson,
  compareIds,
  contentHash,
  deepFreeze,
  type DeepReadonly,
} from './canonical.ts';
import {
  abilityEffects,
  parseJson,
  type DefinitionKind,
  type RevisionRef,
  type StageContact,
} from './contracts.ts';
import { type Outcome, type ForceContribution } from './records.ts';
import { initialResources } from './resources.ts';
import {
  RecordedManifestSchema,
  ReplayCheckpointSchema,
  type RecordedManifest,
  type ReplayCheckpoint,
  type ReplayManifest,
} from './replay.ts';
import {
  StreamRecordSchema,
  type DisplayPath,
  type DisplayState,
  type ProjectileDisplay,
  type StreamRecord,
} from './stream.ts';

const fail = (message: string): never => {
  throw new Error(`Invalid replay: ${message}`);
};
const requireReplay = (condition: boolean, message: string) => {
  if (!condition) fail(message);
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
type RecordedRevision = RecordedManifest['revisions'][number];
function recordedStage(
  ability: DeepReadonly<Extract<RecordedRevision, { kind: 'ability' }>> | undefined,
  contact: StageContact,
) {
  const stage = ability?.definition.stages?.[contact.stageIndex];
  if (
    !stage ||
    stage.id !== contact.stageId ||
    contact.emitterId !== 0 ||
    contact.hitGroupId !== (stage.hit?.group ?? 'shared')
  )
    return fail('stage reference');
  return stage;
}
export type ReplayContext = Awaited<ReturnType<typeof replayContext>>;
/** Validate content identity and resolve display metadata without loading any engine/WASM. */
export async function replayContext(input: unknown, simulationHash: string) {
  const manifest = parseJson(RecordedManifestSchema, input);
  const index = new Map<string, RecordedRevision>();
  for (const revision of manifest.revisions) {
    const key = `${revision.kind}:${revision.id}:${revision.revision}`;
    requireReplay(!index.has(key), 'duplicate revision');
    index.set(key, revision);
    requireReplay(
      revision.contentHash ===
        (await contentHash({
          kind: revision.kind,
          schemaVersion: revision.schemaVersion,
          definition: revision.definition,
        })),
      'revision content hash',
    );
  }
  function get<K extends DefinitionKind>(kind: K, ref: RevisionRef) {
    const r = index.get(`${kind}:${ref.id}:${ref.revision}`);
    if (!r || r.contentHash !== ref.contentHash) return fail(`missing ${kind} revision`);
    return r as Extract<RecordedRevision, { kind: K }>;
  }
  for (const r of manifest.revisions) {
    if (r.kind === 'character') {
      get('policy', r.definition.policy);
      r.definition.abilities.forEach((ref) => get('ability', ref));
      r.definition.equipment.forEach((ref) => get('equipment', ref));
    } else if (r.kind === 'equipment') r.definition.abilities.forEach((ref) => get('ability', ref));
    else if (r.kind === 'ability')
      for (const effect of abilityEffects(r.definition))
        if (effect.kind === 'apply-status') get('status', effect.status);
  }
  const actors = manifest.participants.map((p) => {
    const character = get('character', p.character).definition;
    const refs = [
      ...character.abilities,
      ...character.equipment.flatMap((r) => get('equipment', r).definition.abilities),
    ];
    const abilities = refs.map((r) => get('ability', r));
    requireReplay(
      new Set(abilities.map((a) => a.id)).size === abilities.length,
      'duplicate ability',
    );
    return { participant: p, character, abilities };
  });
  requireReplay(
    actors[0]!.participant.actorId !== actors[1]!.participant.actorId,
    'duplicate actor',
  );
  const rules = get('ruleset', manifest.ruleset).definition;
  requireReplay(rules.rulesVersion === manifest.engineVersion, 'rules/engine version mismatch');
  get('scenario', manifest.scenario);
  requireReplay(
    (await contentHash(manifest.physicsProfile)) === manifest.physicsProfileHash,
    'physics profile hash',
  );
  requireReplay((await contentHash(manifest)) === simulationHash, 'simulation hash');
  return deepFreeze({ manifest, simulationHash, actors, rules });
}
const phases = { boundary: 0, declaration: 1, launch: 2, contact: 3, resolution: 4, terminal: 5 };
const emittedId = (id: string) => {
  if (!/^e\.(0|[1-9][0-9]{0,6})$/.test(id)) return fail('event ID');
  return Number(id.slice(2));
};
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
      if (last.kind === 'terminal') this.validateOutcome(last.outcome, v.state, v.step);
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
  private validateState(state: DisplayState, step: number) {
    requireReplay(new Set(state.actors.map((a) => a.id)).size === 2, 'actor IDs');
    for (const actor of state.actors) {
      const definition = this.context.actors.find((a) => a.participant.actorId === actor.id);
      if (!definition) return fail('unknown actor');
      if (actor.force) {
        const force = actor.force;
        requireReplay(
          force.capMmPerSecond === (this.context.rules.forcedSpeedCapMmPerSecond ?? 100000) &&
            force.fromStep === step - 1 &&
            force.contributors.length > 0 &&
            new Set(force.contributors.map((f) => f.id)).size === force.contributors.length,
          'force interval/contributors',
        );
        for (const contribution of force.contributors) {
          this.validateForce(contribution);
          requireReplay(
            contribution.startAt <= force.fromStep && force.fromStep < contribution.endAt,
            'force active window',
          );
        }
        const total = { x: 0, y: 0, z: 0 };
        for (const f of force.contributors)
          for (const axis of ['x', 'y', 'z'] as const) total[axis] += f.velocityMmPerSecond[axis];
        const norm = Math.sqrt(total.x ** 2 + total.y ** 2 + total.z ** 2);
        const scale = norm > force.capMmPerSecond ? force.capMmPerSecond / norm / 1000 : 0.001;
        requireReplay(
          force.active === norm > 0 &&
            force.capped === norm > force.capMmPerSecond &&
            (['x', 'y', 'z'] as const).every(
              (axis) => Math.abs(force.applied[axis] - total[axis] * scale) < 1e-9,
            ) &&
            (force.active
              ? !!force.gravityBefore &&
                !!force.gravityAfter &&
                !!force.incident &&
                !!force.projectedForce
              : !force.incident && !force.projectedForce && !force.projections.length),
          'force applied sum',
        );
        requireReplay(
          force.projections.every(
            (p, i) => i === 0 || p.fraction >= force.projections[i - 1]!.fraction,
          ),
          'force projection order',
        );
      }
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
      if (actor.action) {
        const action = actor.action;
        const ability = definition.abilities.find((a) => a.id === action.abilityId);
        const activeSteps =
          ability?.definition.attack.kind === 'melee' ? ability.definition.attack.activeSteps : 1;
        const activeUntil = action.activeUntil ?? action.launchAt + activeSteps;
        if (action.stage) {
          const stage = recordedStage(ability, action.stage.contact),
            last = ability!.definition.stages!.at(-1)!;
          requireReplay(
            action.stage.contact.actionId === action.id &&
              action.stage.startAt === action.launchAt + stage.offsetSteps &&
              action.stage.endAt === action.stage.startAt + stage.durationSteps &&
              action.activeUntil === action.launchAt + last.offsetSteps + last.durationSteps &&
              action.stage.shape === (stage.attack?.kind ?? 'hold'),
            'stage display clocks/shape',
          );
          requireReplay(
            action.stage.state !== 'active' ||
              (step >= action.stage.startAt &&
                step < action.stage.endAt &&
                action.phase === 'active'),
            'active stage window',
          );
          const state = action.stage.state;
          requireReplay(
            (action.phase !== 'active' || state === 'active') &&
              (state !== 'preparing' ||
                (step < action.launchAt && action.stage.contact.stageIndex === 0)) &&
              (state !== 'complete' || (stage === last && step >= activeUntil)) &&
              (state !== 'waiting' ||
                step === action.launchAt ||
                (step >= action.stage.endAt && step < activeUntil)),
            'stage state window',
          );
          if (action.stage.geometry) {
            const geometry = action.stage.geometry,
              shape = stage.attack;
            if (geometry.kind === 'blade') {
              if (shape?.kind !== 'arc' && shape?.kind !== 'radial') return fail('blade shape');
              requireReplay(
                geometry.radiusMm === shape.bladeRadiusMm && geometry.poses[0]!.fraction === 0,
                'blade radius/start',
              );
              for (const [i, pose] of geometry.poses.entries())
                requireReplay(
                  pose.root.y === pose.tip.y &&
                    Math.abs(
                      Math.sqrt((pose.tip.x - pose.root.x) ** 2 + (pose.tip.z - pose.root.z) ** 2) -
                        shape.reachMm / 1000,
                    ) < 1e-6 &&
                    (i === 0 || pose.fraction > geometry.poses[i - 1]!.fraction),
                  'blade length/time',
                );
            } else {
              requireReplay(
                !!shape &&
                  (shape.kind === 'melee' || shape.kind === 'hitscan') &&
                  geometry.kind === (shape.kind === 'melee' ? 'sphere' : 'ray') &&
                  geometry.radiusMm === shape.radiusMm,
                'stage geometry shape',
              );
              for (let i = 1; i < geometry.segments.length; i++) {
                const previous = geometry.segments[i - 1]!,
                  current = geometry.segments[i]!;
                requireReplay(
                  Math.abs(previous.to - current.from) <= 1e-12 &&
                    same(previous.end, current.start),
                  'stage geometry continuity',
                );
              }
            }
          }
          if (action.stage.motion) {
            const motion = action.stage.motion,
              configured = stage.selfMotion;
            requireReplay(
              !!configured &&
                motion.kind === configured.kind &&
                motion.speedMmPerSecond === configured.speedMmPerSecond &&
                motion.accelerationMmPerSecond2 === configured.accelerationMmPerSecond2 &&
                motion.fromStep >= action.stage.startAt &&
                motion.fromStep < action.stage.endAt &&
                motion.fromStep < step &&
                (!actor.force?.active ||
                  motion.fromStep !== actor.force.fromStep ||
                  !motion.applied),
              'stage motion reference/time',
            );
          }
        } else
          requireReplay(
            !ability?.definition.stages && action.activeUntil === undefined,
            'missing stage display',
          );
        requireReplay(
          !!ability &&
            action.startedAt <= step &&
            action.startedAt <= action.launchAt &&
            action.launchAt < action.recoveryUntil &&
            step < action.recoveryUntil &&
            (step < action.launchAt
              ? action.phase === 'cast'
              : action.phase !== 'cast' && (action.phase !== 'active' || step < activeUntil)),
          'action reference/time',
        );
      }
    }
    const ids = new Set(state.actors.map((a) => a.id));
    for (const p of state.projectiles) {
      requireReplay(!ids.has(p.id), 'duplicate entity');
      ids.add(p.id);
      this.validateProjectile(p, step);
    }
  }
  private validateForce(force: ForceContribution) {
    const ability = this.context.actors
      .find((a) => a.participant.actorId === force.actorId)
      ?.abilities.find((a) => a.id === force.abilityId);
    const effects = force.stage
      ? recordedStage(ability, force.stage).effects
      : ability?.definition.effects;
    requireReplay(
      !!effects?.some((e) => e.kind === 'force' && e.durationSteps === force.endAt - force.startAt),
      'force definition',
    );
  }
  private validateProjectile(p: ProjectileDisplay, step: number) {
    const owner = this.context.actors.find((a) => a.participant.actorId === p.ownerId);
    const ability = owner?.abilities.find((a) => a.id === p.abilityId);
    const attack = p.stage ? recordedStage(ability, p.stage).attack : ability?.definition.attack;
    requireReplay(!!p.stage === !!ability?.definition.stages, 'projectile stage display');
    requireReplay(
      p.id.startsWith('projectile.') &&
        attack?.kind === 'projectile' &&
        p.radiusMm === attack.radiusMm &&
        p.endStep === p.launchStep + attack.lifetimeSteps &&
        p.launchStep <= step &&
        p.endStep > step,
      'projectile reference/time',
    );
  }
  private validateOutcome(outcome: Outcome, state: DisplayState, step: number) {
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
  private validateEvents(
    record: Exclude<StreamRecord, { kind: 'initial' }>,
    entities: Set<string>,
  ) {
    const events = record.events,
      seen = new Set<number>();
    let previous = [-1, -1, -1];
    for (const [offset, e] of events.entries()) {
      const id = emittedId(e.id);
      requireReplay(
        e.sequence === this.value.nextEvent + offset &&
          id >= this.value.nextEvent &&
          id < this.value.nextEvent + events.length &&
          !seen.has(id),
        'event sequence/identity',
      );
      seen.add(id);
      // IDs track emission/causality; sequence tracks the phase-sorted display order.
      for (const cause of [...e.causes, ...(e.parentEventId ? [e.parentEventId] : [])])
        requireReplay(emittedId(cause) < id, 'event causal reference');
      const maxStep = record.kind === 'interval' ? record.toStep : record.step;
      requireReplay(e.step >= this.value.step && e.step <= maxStep, 'event step');
      if (record.kind === 'boundary')
        requireReplay(e.phase === 'boundary' || e.phase === 'resolution', 'boundary event phase');
      if (record.kind === 'terminal')
        requireReplay(e.kind === 'terminal' && e.phase === 'terminal', 'terminal event');
      else requireReplay(e.phase !== 'terminal' && e.kind !== 'terminal', 'early terminal');
      const order = [e.step, phases[e.phase], e.subtimeMicros];
      requireReplay(
        order[0]! > previous[0]! ||
          (order[0] === previous[0] &&
            (order[1]! > previous[1]! || (order[1] === previous[1] && order[2]! >= previous[2]!))),
        'event order',
      );
      previous = order;
      for (const id of [e.actorId, e.targetId])
        if (id !== null)
          requireReplay(
            this.context.actors.some((a) => a.participant.actorId === id),
            'event actor reference',
          );
      if (e.entityId !== null) requireReplay(entities.has(e.entityId), 'event entity reference');
      if (e.abilityId !== null)
        requireReplay(
          e.actorId === null
            ? this.context.manifest.revisions.some(
                (r) => r.kind === 'ability' && r.id === e.abilityId,
              )
            : this.context.actors
                .find((a) => a.participant.actorId === e.actorId)!
                .abilities.some((a) => a.id === e.abilityId),
          'event ability reference',
        );
      if (e.stage) {
        const ability = this.context.actors
          .find((a) => a.participant.actorId === e.actorId)
          ?.abilities.find((a) => a.id === e.abilityId);
        recordedStage(ability, e.stage);
      }
      if (e.force) this.validateForce(e.force);
    }
    requireReplay(this.value.nextEvent + events.length <= 1_000_001, 'event limit');
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
        prior.state === null && record.state.projectiles.length === 0,
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
      const entities = new Set([...state.actors, ...state.projectiles].map((e) => e.id));
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
            this.validateProjectile(p, prior.step);
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
      this.validateEvents(record, entities);
    }
    this.validateState(state, step);
    state.actors.sort((a, b) => compareIds(a.id, b.id));
    state.projectiles.sort((a, b) => compareIds(a.id, b.id));
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
