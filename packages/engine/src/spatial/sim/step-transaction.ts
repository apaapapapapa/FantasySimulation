import type { PreviousMovement, ActorState, MeleeState, PreparedBattle } from '../state.ts';
import type {
  Budget,
  DisplayPath,
  ProjectileChanges,
  ProjectileDisplay,
  StreamRecord,
} from '@fantasy/domain/spatial/execution';
import { cloneActor, displayActor } from './combat-state.ts';
import type { PendingEffect } from './combat-effects.ts';
import type { beginForcedInterval } from '../rules/forces.ts';
import type { HitLedger } from '../rules/hit-ledger.ts';
import { displayChanges, Journal } from '../rules/journal.ts';
import type { Navigator } from '../world/navigation.ts';
import type { SpatialWorld } from '../world/physics.ts';
import type { ProjectileState } from '../rules/projectiles.ts';
import type { ResourceBudget } from '../rules/resources.ts';
import { attachedStageAlive } from '../rules/stages.ts';
import type { WorkMeter } from './work-meter.ts';
import type { Obstacle } from '../geometry-types.ts';
import type { PendingRelocation } from '../state.ts';
import { displaySpatialObject, type SpatialObject } from '../rules/spatial-objects.ts';
import { canonicalJson, type SpatialObjectChanges } from '@fantasy/domain/spatial/execution';

export const actorId = (actor: ActorState) => actor.body.motion.actor.participant.actorId;
export type SimulationState = {
  actors: ActorState[];
  melees: MeleeState[];
  projectiles: ProjectileState[];
  ledger: HitLedger;
  serial: number;
  relocations?: PendingRelocation[];
  objects?: SpatialObject[];
};
type StepContext = {
  battle: PreparedBattle;
  budget: Budget;
  world: SpatialWorld;
  navigators: ReadonlyMap<string, Navigator>;
  work: WorkMeter;
};

/** A boundary or interval is published only after the complete record fits the journal budget. */
export class StepTransaction {
  readonly context: StepContext;
  readonly previous: SimulationState;
  readonly next: SimulationState;
  readonly step: number;
  readonly journal: Journal;
  readonly before: ReturnType<typeof displayActor>[];
  readonly aiBoundary: boolean;
  readonly effects: PendingEffect[] = [];
  readonly barrierDamage = new Map<string, number>();
  readonly objectRemovals = new Map<string, SpatialObjectChanges['remove'][number]['reason']>();
  readonly spawns: ProjectileDisplay[] = [];
  forcePlans = new Map<string, ReturnType<typeof beginForcedInterval>>();
  previousMovement = new Map<string, PreviousMovement>();
  resourceBudgets = new Map<string, ResourceBudget>();
  paths: DisplayPath[] = [];
  projectileChanges: ProjectileChanges = { spawn: [], update: [], remove: [] };
  private candidateWorld: SpatialWorld | undefined;

  constructor(
    context: StepContext,
    previous: SimulationState,
    step: number,
    sequence: number,
    bytes: number,
    phase: 'boundary' | 'interval',
  ) {
    this.context = { ...context };
    this.previous = previous;
    this.step = step;
    this.before = previous.actors.map((actor) => displayActor(actor, step));
    this.next = {
      actors: previous.actors.map(cloneActor),
      melees:
        phase === 'interval' ? previous.melees.map((attack) => ({ ...attack })) : previous.melees,
      projectiles: [...previous.projectiles],
      ledger: previous.ledger.clone(),
      serial: previous.serial,
      ...(previous.objects ? { objects: previous.objects.map((o) => ({ ...o })) } : {}),
      ...(previous.relocations ? { relocations: [...previous.relocations] } : {}),
    };
    this.journal = new Journal(sequence, bytes, context.budget);
    this.aiBoundary =
      step % (context.battle.manifest.physicsProfile.aiMs / context.battle.rules.stepMs) === 0;
  }
  replaceGeometry(obstacles: Obstacle[]) {
    const candidate = this.context.world.rebuild(obstacles);
    if (candidate === this.context.world) return;
    this.candidateWorld?.free();
    this.candidateWorld = candidate;
    this.context.world = candidate;
  }
  /** Called only after Journal.finish; a failed candidate never replaces committed geometry. */
  commitWorld(previous: SpatialWorld): SpatialWorld {
    const candidate = this.candidateWorld;
    if (!candidate) return previous;
    this.candidateWorld = undefined;
    previous.free();
    return candidate;
  }
  discardWorld() {
    this.candidateWorld?.free();
    this.candidateWorld = undefined;
  }
  objectChanges(): SpatialObjectChanges | undefined {
    const previous = (this.previous.objects ?? [])
        .filter((o) => o.active)
        .map(displaySpatialObject),
      next = (this.next.objects ?? []).filter((o) => o.active).map(displaySpatialObject);
    if (!previous.length && !next.length) return undefined;
    const changes: SpatialObjectChanges = {
      spawn: next.filter((o) => !previous.some((p) => p.id === o.id)),
      update: next.filter((o) =>
        previous.some((p) => p.id === o.id && canonicalJson(p) !== canonicalJson(o)),
      ),
      remove: previous
        .filter((o) => !next.some((p) => p.id === o.id))
        .map((o) => ({ id: o.id, reason: this.objectRemovals.get(o.id) ?? 'expired' })),
    };
    return changes.spawn.length + changes.update.length + changes.remove.length
      ? changes
      : undefined;
  }
  boundaryRecord(): Extract<StreamRecord, { kind: 'boundary' }> {
    return {
      kind: 'boundary',
      schemaVersion: 1,
      step: this.step,
      ...(this.objectChanges() ? { objects: this.objectChanges()! } : {}),
      changes: displayChanges(
        this.before,
        this.next.actors.map((actor) => displayActor(actor, this.step)),
      ),
      events: this.journal.events,
    };
  }
  intervalRecord(): Extract<StreamRecord, { kind: 'interval' }> {
    return {
      kind: 'interval',
      schemaVersion: 1,
      ...(this.objectChanges() ? { objects: this.objectChanges()! } : {}),
      fromStep: this.step,
      toStep: this.step + 1,
      paths: this.paths,
      projectiles: this.projectileChanges,
      changes: displayChanges(
        this.before,
        this.next.actors.map((actor) => displayActor(actor, this.step + 1)),
      ),
      events: this.journal.events,
    };
  }
  finishInterval() {
    this.next.ledger.prune(
      new Set([
        ...this.next.actors.flatMap((actor) =>
          actor.actions.action?.stages ? [actor.actions.action.id] : [],
        ),
        ...(this.next.objects ?? []).map((o) => o.actionId),
        ...this.next.projectiles.flatMap((projectile) =>
          projectile.stage ? [projectile.stage.actionId] : [],
        ),
      ]),
    );
    this.next.melees = this.next.melees.filter((attack) =>
      attachedStageAlive(attack, this.next.actors, this.step + 1),
    );
  }
}
