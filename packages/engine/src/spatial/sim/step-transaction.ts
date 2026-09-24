import type {
  Budget,
  DisplayPath,
  ProjectileChanges,
  ProjectileDisplay,
  StreamRecord,
} from '@fantasy/domain/spatial/execution';
import { cloneActor, displayActor, type ActorState, type MeleeState } from '../combat-state.ts';
import type { PendingEffect } from '../combat-effects.ts';
import type { beginForcedInterval } from '../forces.ts';
import type { HitLedger } from '../hit-ledger.ts';
import { displayChanges, Journal } from '../journal.ts';
import type { Navigator } from '../navigation.ts';
import type { SpatialWorld } from '../physics.ts';
import type { PreparedBattle } from '../prepare.ts';
import type { ProjectileState } from '../projectiles.ts';
import type { ResourceBudget } from '../resources.ts';
import { attachedStageAlive } from '../stages.ts';
import type { WorkMeter } from './work-meter.ts';

export const actorId = (actor: ActorState) => actor.motion.actor.participant.actorId;
export type SimulationState = {
  actors: ActorState[];
  melees: MeleeState[];
  projectiles: ProjectileState[];
  ledger: HitLedger;
  serial: number;
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
  readonly spawns: ProjectileDisplay[] = [];
  forcePlans = new Map<string, ReturnType<typeof beginForcedInterval>>();
  previousMovement = new Map<string, Pick<ActorState, 'intent' | 'decision'>>();
  resourceBudgets = new Map<string, ResourceBudget>();
  paths: DisplayPath[] = [];
  projectileChanges: ProjectileChanges = { spawn: [], update: [], remove: [] };

  constructor(
    context: StepContext,
    previous: SimulationState,
    step: number,
    sequence: number,
    bytes: number,
    phase: 'boundary' | 'interval',
  ) {
    this.context = context;
    this.previous = previous;
    this.step = step;
    this.before = previous.actors.map((actor) => displayActor(actor, step));
    this.next = {
      actors: previous.actors.map(cloneActor),
      melees:
        phase === 'interval' ? previous.melees.map((attack) => ({ ...attack })) : previous.melees,
      projectiles: [...previous.projectiles],
      ledger: phase === 'interval' ? previous.ledger.clone() : previous.ledger,
      serial: previous.serial,
    };
    this.journal = new Journal(sequence, bytes, context.budget);
    this.aiBoundary =
      step % (context.battle.manifest.physicsProfile.aiMs / context.battle.rules.stepMs) === 0;
  }
  boundaryRecord(): Extract<StreamRecord, { kind: 'boundary' }> {
    return {
      kind: 'boundary',
      schemaVersion: 1,
      step: this.step,
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
        ...this.next.actors.flatMap((actor) => (actor.action?.stages ? [actor.action.id] : [])),
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
