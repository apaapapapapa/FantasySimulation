import type { ActorState, MeleeState, PreparedBattle } from './state.ts';
import {
  BudgetSchema,
  DEFAULT_BUDGET,
  compareIds,
  type Budget,
  type Outcome,
  type StreamRecord,
  type BattleResult,
} from '@fantasy/domain/spatial/execution';
import { initialActor, decisionState, displayActor } from './sim/combat-state.ts';
import { Journal, recordBytes } from './rules/journal.ts';
import { Navigator } from './world/navigation.ts';
import { SpatialBudgetError } from './world/physics.ts';
import { UnresolvedRuleError } from './rules/status.ts';
import { createBattleWorld } from './world/terrain.ts';
import { type ProjectileState } from './rules/projectiles.ts';
import { attachedStageAlive } from './rules/stages.ts';
import { HitLedger } from './rules/hit-ledger.ts';
import { StepTransaction, actorId } from './sim/step-transaction.ts';
import { WorkMeter } from './sim/work-meter.ts';
import { boundaryPhase } from './sim/phase-boundary.ts';
import { decisionPhase } from './sim/phase-decision.ts';
import { startPhase } from './sim/phase-start.ts';
import { releasePhase } from './sim/phase-release.ts';
import { contactPhase } from './sim/phase-contact.ts';
import { resolutionPhase } from './sim/phase-resolution.ts';
export type SimulationEnd = {
  steps: number;
  outcome: Outcome;
  decisionState: unknown;
  physicsState: Uint8Array;
  stats: BattleResult['stats'];
};
const verdict = (actors: ActorState[]): Outcome | null => {
  const alive = actors.filter((a) => a.vitals.resources.hp > 0);
  return alive.length === 0
    ? { kind: 'draw', reason: 'mutual-defeat' }
    : alive.length === 1
      ? { kind: 'win', winner: actorId(alive[0]!) }
      : null;
};
function outcomeFromError(error: unknown, diagnostics: boolean): Outcome {
  if (error instanceof SpatialBudgetError)
    return {
      kind: 'truncated',
      resource: error.resource,
      reason: error.message,
      ...(diagnostics && error.details ? { details: error.details } : {}),
    };
  if (error instanceof UnresolvedRuleError)
    return {
      kind: 'unresolved',
      ruleId: error.ruleId,
      revisions: error.revisions,
      reason: error.message,
      ...(error.interferences ? { interferences: error.interferences } : {}),
    };
  throw error;
}
/** A synchronous pull stream: the host controls pace, cancellation and I/O. Never reads a wall clock. */
export function* simulate(
  battle: PreparedBattle,
  inputBudget: Budget = DEFAULT_BUDGET,
): Generator<StreamRecord, SimulationEnd> {
  const budget = BudgetSchema.parse(inputBudget);
  // Validate geometry before counting execution work. Invalid spawn is input failure, not a rule outcome.
  const world = createBattleWorld(battle);
  let step = 0,
    sequence = 0,
    bytes = 0,
    serial = 0;
  let outcome: Outcome | null = null;
  let actors: ActorState[] = [];
  let melees: MeleeState[] = [];
  let projectiles: ProjectileState[] = [];
  let ledger = new HitLedger();
  const work = new WorkMeter(budget);
  try {
    actors = [...battle.actors]
      .sort((a, b) => compareIds(a.participant.actorId, b.participant.actorId))
      .map((actor) => initialActor(world, actor));
    const navigators = new Map(
      actors.map((a) => [
        actorId(a),
        new Navigator(world, a.body.motion.actor, battle.scenario, battle.rules),
      ]),
    );
    world.casts = 0;
    world.castLimit = budget.maxCasts;
    const initial: StreamRecord = {
      kind: 'initial',
      schemaVersion: 1,
      step: 0,
      state: { actors: actors.map((a) => displayActor(a, 0)), projectiles: [] },
    };
    // Initial/terminal control envelopes are bounded separately from game records (32 KiB reserve).
    const controlBytes = recordBytes(initial);
    yield structuredClone(initial);
    while (step < battle.rules.maxSteps && !outcome) {
      const context = { battle, budget, world, navigators, work };
      const previous = () => ({ actors, melees, projectiles, ledger, serial });
      // Boundary and interval are independent atomic commits. Work already attempted is retained.
      try {
        const tx = new StepTransaction(context, previous(), step, sequence, bytes, 'boundary');
        boundaryPhase(tx);
        const record = tx.boundaryRecord();
        if (record.changes.length || tx.journal.events.length) {
          const committed = tx.journal.finish(record);
          actors = tx.next.actors;
          bytes += committed.bytes;
          sequence += tx.journal.events.length;
          melees = melees.filter((m) => attachedStageAlive(m, actors, step));
          yield structuredClone(record);
        } else actors = tx.next.actors;
        outcome = verdict(actors);
        if (outcome) break;
      } catch (error) {
        outcome = outcomeFromError(error, !!battle.rules.interferenceDiagnostics);
        break;
      }
      try {
        const tx = new StepTransaction(context, previous(), step, sequence, bytes, 'interval');
        decisionPhase(tx);
        startPhase(tx);
        releasePhase(tx);
        contactPhase(tx);
        resolutionPhase(tx);
        const record = tx.intervalRecord();
        const committed = tx.journal.finish(record);
        tx.finishInterval();
        ({ actors, melees, projectiles, ledger, serial } = tx.next);
        step++;
        bytes += committed.bytes;
        sequence += tx.journal.events.length;
        yield structuredClone(record);
        outcome = verdict(actors);
      } catch (error) {
        outcome = outcomeFromError(error, !!battle.rules.interferenceDiagnostics);
      }
    }
    outcome ??= { kind: 'draw', reason: 'time-limit' };
    let record = terminalRecord(sequence, step, outcome, budget);
    let terminalBytes = recordBytes(record);
    if (
      outcome.kind === 'unresolved' &&
      outcome.interferences &&
      controlBytes + terminalBytes > 32768
    ) {
      outcome = {
        kind: 'truncated',
        resource: 'interference-bytes',
        reason: 'Interference exceeds terminal control reserve',
        details: { observed: controlBytes + terminalBytes, limit: 32768, cause: outcome.ruleId },
      };
      record = terminalRecord(sequence, step, outcome, budget);
      terminalBytes = recordBytes(record);
    }
    if (controlBytes + terminalBytes > 32768) throw new Error('Control envelope exceeded');
    yield structuredClone(record);
    return {
      steps: step,
      outcome,
      decisionState: {
        step,
        actors: actors.map(decisionState),
        melees: melees.map((m) => ({
          ...m,
          ability: {
            id: m.ability.id,
            revision: m.ability.revision,
            contentHash: m.ability.contentHash,
          },
        })),
        serial,
        ...(ledger.snapshot().length ? { hitLedger: ledger.snapshot() } : {}),
        projectiles: projectiles.map((p) => ({
          ...p,
          ability: {
            id: p.ability.id,
            revision: p.ability.revision,
            contentHash: p.ability.contentHash,
          },
        })),
      },
      physicsState: world.world.takeSnapshot(),
      stats: {
        events: sequence + 1,
        logBytes: bytes + controlBytes + terminalBytes,
        casts: world.casts,
        candidates: work.candidates,
        pathNodes: work.pathNodes,
        peakProjectiles: work.peakProjectiles,
        ...(battle.actors.some((a) => a.abilities.some((b) => b.definition.reaction))
          ? { reactionAttempts: work.reactions.attempts }
          : {}),
      },
    };
  } finally {
    world.free();
  }
}

function terminalRecord(
  sequence: number,
  step: number,
  outcome: Outcome,
  budget: Budget,
): StreamRecord {
  const terminal = new Journal(sequence, 0, {
    ...budget,
    maxEvents: Number.MAX_SAFE_INTEGER,
    maxBytes: 32768,
    maxFrameBytes: 32768,
  });
  terminal.emit({
    kind: 'terminal',
    step,
    phase: 'terminal',
    ruleId: `battle.${outcome.kind}`,
    reason: outcome.kind === 'win' ? outcome.winner : outcome.reason,
  });
  return { kind: 'terminal', schemaVersion: 1, step, outcome, events: terminal.events };
}
