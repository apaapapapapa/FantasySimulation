import {
  BudgetSchema,
  DEFAULT_BUDGET,
  compareIds,
  type Budget,
  type Outcome,
  type StreamRecord,
  type BattleResult,
} from '@fantasy/domain/spatial';
import {
  actionClock,
  hitscan,
  inObservedRange,
  launchDirection,
  meleeTrace,
  muzzleBlocked,
  payCost,
  traceAttack,
} from './attacks.ts';
import {
  cloneActor,
  decisionState,
  displayActor,
  type ActorState,
  type MeleeState,
  type AbilityRevision,
} from './combat-state.ts';
import { commitEffects, type PendingEffect } from './combat-effects.ts';
import { displayChanges, Journal, recordBytes } from './journal.ts';
import { sub, ZERO } from './math.ts';
import { initialMotion, moveActors } from './movement.ts';
import { Navigator } from './navigation.ts';
import {
  bodyPoint,
  conditionMatches,
  emptyMemory,
  perceive,
  type DecisionView,
} from './perception.ts';
import { SpatialBudgetError } from './physics.ts';
import { choosePolicy, steerPolicy } from './policy.ts';
import type { PreparedBattle } from './prepare.ts';
import { effectiveStats, statusBoundary, UnresolvedRuleError } from './status.ts';
import { createBattleWorld } from './terrain.ts';

export type SimulationEnd = {
  steps: number;
  outcome: Outcome;
  decisionState: unknown;
  physicsState: Uint8Array;
  stats: BattleResult['stats'];
};
const actorId = (a: ActorState) => a.motion.actor.participant.actorId;
const viewOf = (a: ActorState, step: number): DecisionView => ({
  self: a.motion,
  resources: a.resources,
  memory: a.memory,
  statusIds: a.statuses
    .filter((s) => s.startStep <= step && step < s.endStep)
    .map((s) => s.revision.id),
});
const verdict = (actors: ActorState[]): Outcome | null => {
  const alive = actors.filter((a) => a.resources.hp > 0);
  return alive.length === 0
    ? { kind: 'draw', reason: 'mutual-defeat' }
    : alive.length === 1
      ? { kind: 'win', winner: actorId(alive[0]!) }
      : null;
};
function effectsOf(
  actor: ActorState,
  ability: AbilityRevision,
  targetId: string,
  parentEventId: string,
  step: number,
): PendingEffect[] {
  const attack = effectiveStats(actor.motion.actor, actor.statuses, step).attack;
  return ability.definition.effects.map((effect) => ({
    actorId: actorId(actor),
    targetId,
    effect,
    attack,
    parentEventId,
    abilityId: ability.id,
  }));
}
/** A synchronous pull stream: the host controls pace, cancellation and I/O. Never reads a wall clock. */
export function* simulate(
  battle: PreparedBattle,
  inputBudget: Budget = DEFAULT_BUDGET,
): Generator<StreamRecord, SimulationEnd> {
  const budget = BudgetSchema.parse(inputBudget);
  if (
    battle.actors.some((a) =>
      a.abilities.some((ability) => ability.definition.attack.kind === 'projectile'),
    )
  )
    throw new Error('Projectile execution is added by 3D-07');
  // Validate geometry before counting execution work. Invalid spawn is input failure, not a rule outcome.
  const world = createBattleWorld(battle);
  let step = 0,
    sequence = 0,
    bytes = 0,
    serial = 0,
    candidates = 0,
    pathNodes = 0;
  let outcome: Outcome | null = null;
  let actors: ActorState[] = [];
  let melees: MeleeState[] = [];
  try {
    actors = [...battle.actors]
      .sort((a, b) => compareIds(a.participant.actorId, b.participant.actorId))
      .map((actor) => ({
        motion: initialMotion(world, actor),
        resources: {
          hp: actor.character.stats.hp,
          mp: actor.character.stats.mp,
          shield: actor.character.stats.shield,
        },
        statuses: [],
        memory: emptyMemory(),
        decision: { abilityId: null, goal: null, facing: actor.participant.facing },
        intent: {
          direction: { ...ZERO },
          facing: actor.participant.facing,
          jump: false,
          flight: false,
          canMove: true,
          speedBps: 10000,
        },
        action: null,
        readyAt: 0,
        used: {},
        cooldowns: {},
        random: actor.participant.rngSeed,
      }));
    const navigators = new Map(
      actors.map((a) => [
        actorId(a),
        new Navigator(world, a.motion.actor, battle.scenario, battle.rules),
      ]),
    );
    world.casts = 0;
    world.castLimit = budget.maxCasts;
    const initial: StreamRecord = {
      kind: 'initial',
      schemaVersion: 1,
      step: 0,
      state: { actors: actors.map((a) => displayActor(a, 0)) },
    };
    // Initial/terminal control envelopes are bounded separately from game records (32 KiB reserve).
    const controlBytes = recordBytes(initial);
    yield structuredClone(initial);
    while (step < battle.rules.maxSteps && !outcome) {
      // Expiry/periodic and startup form an atomic boundary transaction, distinct from the interval.
      try {
        const before = actors.map((a) => displayActor(a, step));
        const next = actors.map(cloneActor);
        const journal = new Journal(sequence, bytes, budget);
        if (step === 0) {
          const effects: PendingEffect[] = [];
          for (const actor of next) {
            const startup = actor.motion.actor.abilities.filter(
              (a) =>
                a.definition.trigger === 'battle-start' &&
                conditionMatches(a.definition.condition, viewOf(actor, step)),
            );
            const hp = startup.reduce((n, a) => n + a.definition.costs.hp, 0),
              mp = startup.reduce((n, a) => n + a.definition.costs.mp, 0);
            if (hp > actor.resources.hp || mp > actor.resources.mp) {
              for (const ability of startup)
                journal.emit({
                  kind: 'fizzle',
                  step,
                  phase: 'boundary',
                  actorId: actorId(actor),
                  abilityId: ability.id,
                  ruleId: 'startup.cost-group',
                  reason: 'Combined startup costs exceed resources; none are paid',
                });
              continue;
            }
            const old = { ...actor.resources };
            actor.resources = { ...old, hp: old.hp - hp, mp: old.mp - mp };
            const cost = startup.length
              ? journal.emit({
                  kind: 'cost',
                  step,
                  phase: 'boundary',
                  actorId: actorId(actor),
                  ruleId: 'startup.cost-group',
                  before: old,
                  after: { ...actor.resources },
                  reason: 'Simultaneous startup cost group',
                })
              : null;
            for (const ability of startup) {
              actor.used[ability.id] = 1;
              const launch = journal.emit({
                kind: 'launch',
                step,
                phase: 'boundary',
                actorId: actorId(actor),
                abilityId: ability.id,
                parentEventId: cost!.id,
                ruleId: 'startup.launch',
              });
              effects.push(...effectsOf(actor, ability, actorId(actor), launch.id, step));
            }
          }
          commitEffects(next, effects, battle, journal, step, step, 'boundary', budget);
        }
        const periodic: PendingEffect[] = [];
        for (const actor of next) {
          const boundary = statusBoundary(actor.statuses, step);
          actor.statuses = boundary.statuses;
          for (const removed of boundary.removed)
            journal.emit({
              kind: 'status-remove',
              step,
              phase: 'boundary',
              actorId: actorId(actor),
              ruleId: 'status.expired',
              causes: [...removed.causes],
              reason: removed.revision.id,
            });
          for (const pulse of boundary.pulses)
            periodic.push({
              actorId: null,
              targetId: actorId(actor),
              effect:
                pulse.effect.kind === 'heal'
                  ? { kind: 'heal', amount: pulse.effect.amount }
                  : {
                      kind: 'damage',
                      amount: pulse.effect.amount,
                      attackScaleBps: 0,
                      element: pulse.effect.element,
                    },
              attack: 0,
              parentEventId: null,
              abilityId: null,
              causes: pulse.causes,
            });
        }
        if (periodic.length)
          commitEffects(next, periodic, battle, journal, step, step, 'boundary', budget);
        const changes = displayChanges(
          before,
          next.map((a) => displayActor(a, step)),
        );
        const record: StreamRecord = {
          kind: 'boundary',
          schemaVersion: 1,
          step,
          changes,
          events: journal.events,
        };
        if (changes.length || journal.events.length) {
          const committed = journal.finish(record);
          actors = next;
          bytes += committed.bytes;
          sequence += journal.events.length;
          yield structuredClone(record);
        } else actors = next;
        outcome = verdict(actors);
        if (outcome) break;
      } catch (error) {
        if (error instanceof SpatialBudgetError)
          outcome = { kind: 'truncated', resource: error.resource, reason: error.message };
        else if (error instanceof UnresolvedRuleError)
          outcome = {
            kind: 'unresolved',
            ruleId: error.ruleId,
            revisions: error.revisions,
            reason: error.message,
          };
        else throw error;
        break;
      }
      try {
        const before = actors.map((a) => displayActor(a, step));
        const next = actors.map(cloneActor),
          attacks = melees.map((m) => ({ ...m }));
        let nextSerial = serial;
        const journal = new Journal(sequence, bytes, budget),
          effects: PendingEffect[] = [];
        const aiBoundary = step % (battle.manifest.physicsProfile.aiMs / battle.rules.stepMs) === 0;
        // Observe and choose before either participant pays or declares anything.
        for (const actor of next) {
          const enemy = actors.find((a) => actorId(a) !== actorId(actor))!;
          actor.memory = perceive(world, actor.motion, enemy.motion, [], step, actor.memory);
          if (actor.action && actor.action.recoveryUntil <= step) actor.action = null;
          const stats = effectiveStats(actor.motion.actor, actor.statuses, step);
          const view = viewOf(actor, step);
          const ready = new Set(
            actor.motion.actor.abilities
              .filter(
                (a) => a.definition.trigger === 'action' && (actor.cooldowns[a.id] ?? 0) <= step,
              )
              .map((a) => a.id),
          );
          if (aiBoundary) actor.decision = choosePolicy(view, ready, stats.flight);
          const canMove =
            !stats.rooted &&
            !(
              actor.action &&
              step < actor.action.launchAt &&
              actor.action.ability.definition.movementWhileCasting === 'stop'
            );
          if (aiBoundary || actor.intent.flight !== stats.flight) {
            if (!aiBoundary) actor.decision = choosePolicy(view, new Set(), stats.flight);
            const steering = steerPolicy(view, actor.decision, navigators.get(actorId(actor))!, {
              flight: stats.flight,
              canMove,
              speedBps: stats.speedBps,
              maxPathNodes: budget.maxPathNodes,
            });
            pathNodes += steering.navigation?.visited ?? 0;
            if (steering.navigation?.kind === 'budget-exceeded')
              throw new SpatialBudgetError('path-nodes');
            actor.intent = steering.intent;
          }
          actor.intent = {
            ...actor.intent,
            canMove,
            speedBps: stats.speedBps,
            flight: stats.flight,
          };
        }
        for (const actor of next) {
          const view = viewOf(actor, step);
          if (aiBoundary && step >= actor.readyAt && actor.decision.abilityId) {
            const ability = actor.motion.actor.abilities.find(
              (a) => a.id === actor.decision.abilityId,
            )!;
            const definition = ability.definition;
            const clock = actionClock(
              definition,
              actor.motion.actor.character.stats.actionSpeedBps,
              step,
            );
            if (clock) {
              const payment = payCost(definition, actor.resources, actor.used[ability.id] ?? 0);
              if (!inObservedRange(definition, view) || !payment.ok) {
                actor.readyAt =
                  step +
                  Math.max(
                    1,
                    Math.ceil(
                      (definition.recoverySteps * 10000) /
                        actor.motion.actor.character.stats.actionSpeedBps,
                    ),
                  );
                journal.emit({
                  kind: 'fizzle',
                  step,
                  phase: 'declaration',
                  actorId: actorId(actor),
                  abilityId: ability.id,
                  ruleId: 'action.start',
                  reason: payment.ok
                    ? 'observed-range-or-facing'
                    : `insufficient-${payment.reason}`,
                });
              } else {
                const start = journal.emit({
                  kind: 'cast-start',
                  step,
                  phase: 'declaration',
                  actorId: actorId(actor),
                  abilityId: ability.id,
                  ruleId: 'action.start',
                });
                journal.emit({
                  kind: 'cost',
                  step,
                  phase: 'declaration',
                  actorId: actorId(actor),
                  abilityId: ability.id,
                  parentEventId: start.id,
                  ruleId: 'action.cost',
                  before: { ...actor.resources },
                  after: { ...payment.resources },
                });
                actor.resources = payment.resources;
                actor.used[ability.id] = (actor.used[ability.id] ?? 0) + 1;
                actor.cooldowns[ability.id] = clock.cooldownUntil;
                actor.readyAt = clock.recoveryUntil;
                actor.action = {
                  id: `a.${nextSerial++}`,
                  ability,
                  cause: start.id,
                  startedAt: step,
                  ...clock,
                  released: false,
                };
                if (definition.movementWhileCasting === 'stop' && definition.castSteps > 0)
                  actor.intent = { ...actor.intent, canMove: false };
              }
            }
          }
        }
        for (const actor of next) {
          const action = actor.action;
          if (!action || action.released || action.launchAt !== step) continue;
          action.released = true;
          const definition = action.ability.definition;
          if (
            !inObservedRange(definition, viewOf(actor, step)) ||
            !conditionMatches(definition.condition, viewOf(actor, step))
          ) {
            journal.emit({
              kind: 'fizzle',
              step,
              phase: 'launch',
              actorId: actorId(actor),
              abilityId: action.ability.id,
              parentEventId: action.cause,
              ruleId: 'action.release',
              reason: 'Release condition/range no longer holds; cost is retained',
            });
            continue;
          }
          const launch = journal.emit({
            kind: 'launch',
            step,
            phase: 'launch',
            actorId: actorId(actor),
            abilityId: action.ability.id,
            parentEventId: action.cause,
            ruleId: 'action.release',
          });
          if (definition.attack.kind === 'direct') {
            effects.push(...effectsOf(actor, action.ability, actorId(actor), launch.id, step));
            continue;
          }
          const enemy = next.find((a) => actorId(a) !== actorId(actor))!;
          const aim = launchDirection(
            actor.motion.facing,
            definition.aimErrorMilliDegrees,
            actor.random,
          );
          actor.random = aim.random;
          if (definition.attack.kind === 'hitscan') {
            if (++candidates > budget.maxCandidates) throw new SpatialBudgetError('candidates');
            const contact = hitscan(
              world,
              actor.motion,
              enemy.motion,
              aim.direction,
              definition.rangeMm / 1000,
              definition.attack.radiusMm / 1000,
            );
            if (contact) {
              const hit = journal.emit({
                kind: contact.kind === 'body' ? 'hit' : 'fizzle',
                step,
                phase: 'contact',
                actorId: actorId(actor),
                targetId: contact.kind === 'body' ? actorId(enemy) : null,
                abilityId: action.ability.id,
                parentEventId: launch.id,
                ruleId: 'hitscan.first-contact',
                point: contact.point,
                reason: contact.kind,
              });
              if (contact.kind === 'body')
                effects.push(...effectsOf(actor, action.ability, actorId(enemy), hit.id, step));
            }
          } else if (definition.attack.kind === 'melee') {
            if (muzzleBlocked(world, actor.motion))
              journal.emit({
                kind: 'fizzle',
                step,
                phase: 'launch',
                actorId: actorId(actor),
                abilityId: action.ability.id,
                parentEventId: launch.id,
                ruleId: 'melee.muzzle-blocked',
              });
            else
              attacks.push({
                id: action.id,
                actorId: actorId(actor),
                ability: action.ability,
                cause: launch.id,
                launchStep: step,
                direction: aim.direction,
                offset: sub(
                  bodyPoint(actor.motion, actor.motion.actor.character.body.muzzleOffset),
                  actor.motion.position,
                ),
                attack: effectiveStats(actor.motion.actor, actor.statuses, step).attack,
                hits: 0,
              });
          }
        }
        const moved = moveActors(
          world,
          next.map((a) => a.motion),
          new Map(next.map((a) => [actorId(a), a.intent])),
          battle.rules,
          budget.maxMoveSegments,
        );
        const surviving: MeleeState[] = [];
        for (const attack of attacks) {
          const shape = attack.ability.definition.attack;
          if (shape.kind !== 'melee') throw new Error('Invalid active melee');
          const owner = moved.find((a) => a.state.actor.participant.actorId === attack.actorId)!;
          const enemy = moved.find((a) => a.state.actor.participant.actorId !== attack.actorId)!;
          const trace = meleeTrace(
            owner.trace,
            attack.offset,
            attack.direction,
            Math.min(shape.reachMm, attack.ability.definition.rangeMm) / 1000,
            step - attack.launchStep,
            shape.activeSteps,
          );
          if (++candidates > budget.maxCandidates) throw new SpatialBudgetError('candidates');
          const contact = traceAttack(
            world,
            trace,
            shape.radiusMm / 1000,
            enemy.state,
            enemy.trace,
          );
          if (contact) {
            const hit = journal.emit({
              kind: contact.kind === 'body' ? 'hit' : 'fizzle',
              step,
              phase: 'contact',
              subtimeMicros: Math.round(contact.time * 1_000_000),
              actorId: attack.actorId,
              targetId: contact.kind === 'body' ? enemy.state.actor.participant.actorId : null,
              abilityId: attack.ability.id,
              parentEventId: attack.cause,
              point: contact.point,
              ruleId: 'melee.first-contact',
              reason: contact.kind,
            });
            if (contact.kind === 'body') {
              attack.hits++;
              for (const effect of attack.ability.definition.effects)
                effects.push({
                  actorId: attack.actorId,
                  targetId: enemy.state.actor.participant.actorId,
                  effect,
                  attack: attack.attack,
                  parentEventId: hit.id,
                  abilityId: attack.ability.id,
                });
            }
          }
          if (
            contact?.kind !== 'wall' &&
            attack.hits < shape.maxHitsPerTarget &&
            step + 1 < attack.launchStep + shape.activeSteps
          )
            surviving.push(attack);
        }
        for (const actor of next) {
          const movement = moved.find((m) => m.state.actor.participant.actorId === actorId(actor))!;
          actor.motion = movement.state;
          if (movement.landed) {
            const land = journal.emit({
              kind: 'land',
              step,
              phase: 'contact',
              subtimeMicros: 1_000_000,
              actorId: actorId(actor),
              ruleId: 'movement.land',
              point: actor.motion.position,
              amount: movement.fallDamage,
            });
            if (movement.fallDamage)
              effects.push({
                actorId: null,
                targetId: actorId(actor),
                attack: 0,
                effect: {
                  kind: 'damage',
                  amount: movement.fallDamage,
                  attackScaleBps: 0,
                  element: 'physical',
                },
                parentEventId: land.id,
                abilityId: null,
              });
          }
        }
        commitEffects(next, effects, battle, journal, step, step + 1, 'resolution', budget);
        const record: StreamRecord = {
          kind: 'interval',
          schemaVersion: 1,
          fromStep: step,
          toStep: step + 1,
          paths: moved.map((m) => ({
            entityId: m.state.actor.participant.actorId,
            segments: m.trace,
          })),
          changes: displayChanges(
            before,
            next.map((a) => displayActor(a, step + 1)),
          ),
          events: journal.events,
        };
        const committed = journal.finish(record);
        actors = next;
        melees = surviving;
        serial = nextSerial;
        step++;
        bytes += committed.bytes;
        sequence += journal.events.length;
        yield structuredClone(record);
        outcome = verdict(actors);
      } catch (error) {
        if (error instanceof SpatialBudgetError)
          outcome = { kind: 'truncated', resource: error.resource, reason: error.message };
        else if (error instanceof UnresolvedRuleError)
          outcome = {
            kind: 'unresolved',
            ruleId: error.ruleId,
            revisions: error.revisions,
            reason: error.message,
          };
        else throw error;
      }
    }
    outcome ??= { kind: 'draw', reason: 'time-limit' };
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
      reason:
        outcome.kind === 'unresolved' || outcome.kind === 'truncated'
          ? outcome.reason
          : outcome.kind === 'draw'
            ? outcome.reason
            : outcome.winner,
    });
    const record: StreamRecord = {
      kind: 'terminal',
      schemaVersion: 1,
      step,
      outcome,
      events: terminal.events,
    };
    const terminalBytes = recordBytes(record);
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
      },
      physicsState: world.world.takeSnapshot(),
      stats: {
        events: sequence + 1,
        logBytes: bytes + controlBytes + terminalBytes,
        casts: world.casts,
        candidates,
        pathNodes,
        peakProjectiles: 0,
      },
    };
  } finally {
    world.free();
  }
}
