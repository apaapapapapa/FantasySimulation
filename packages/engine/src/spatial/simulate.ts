import {
  BudgetSchema,
  DEFAULT_BUDGET,
  compareIds,
  type Budget,
  type Outcome,
  type StreamRecord,
  type BattleResult,
  type ProjectileDisplay,
} from '@fantasy/domain/spatial';
import {
  actionClock,
  hitscan,
  inObservedRange,
  launchDirection,
  meleeTrace,
  muzzleBlocked,
  traceAttack,
} from './attacks.ts';
import {
  cloneActor,
  initialActor,
  decisionState,
  displayActor,
  type ActorState,
  type MeleeState,
  type AbilityRevision,
} from './combat-state.ts';
import { commitEffects, contactObservation, type PendingEffect } from './combat-effects.ts';
import { displayChanges, Journal, recordBytes } from './journal.ts';
import { mul, sub } from './math.ts';
import { moveActors } from './movement.ts';
import { ResourceBudget } from './resources.ts';
import { recoverActorResources } from './resource-step.ts';
import { canMaintainFlight, resourceReady } from './locomotion.ts';
import { reserveMotion } from './motion-resources.ts';
import { Navigator } from './navigation.ts';
import { knownTerrainWorld } from './known-terrain.ts';
import { selfView } from './self-view.ts';
import { blockedBySilence } from './categories.ts';
import { bodyPoint, conditionMatches, perceive } from './perception.ts';
import { SpatialBudgetError } from './physics.ts';
import { choosePolicy, steerPolicy } from './policy.ts';
import type { PreparedBattle } from './prepare.ts';
import { effectiveStats, statusBoundary, UnresolvedRuleError } from './status.ts';
import { createBattleWorld } from './terrain.ts';
import { displayProjectile, type ProjectileState } from './projectiles.ts';
import { stepProjectiles } from './projectile-step.ts';
import { damageSource } from './damage.ts';

export type SimulationEnd = {
  steps: number;
  outcome: Outcome;
  decisionState: unknown;
  physicsState: Uint8Array;
  stats: BattleResult['stats'];
};
const actorId = (a: ActorState) => a.motion.actor.participant.actorId;
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
  const source = damageSource(effectiveStats(actor.motion.actor, actor.statuses, step));
  return ability.definition.effects.map((effect) => ({
    actorId: actorId(actor),
    targetId,
    effect,
    ...source,
    parentEventId,
    abilityId: ability.id,
  }));
}
function outcomeFromError(error: unknown): Outcome {
  if (error instanceof SpatialBudgetError)
    return { kind: 'truncated', resource: error.resource, reason: error.message };
  if (error instanceof UnresolvedRuleError)
    return {
      kind: 'unresolved',
      ruleId: error.ruleId,
      revisions: error.revisions,
      reason: error.message,
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
    serial = 0,
    candidates = 0,
    pathNodes = 0,
    peakProjectiles = 0;
  let outcome: Outcome | null = null;
  let actors: ActorState[] = [];
  let melees: MeleeState[] = [];
  let projectiles: ProjectileState[] = [];
  try {
    actors = [...battle.actors]
      .sort((a, b) => compareIds(a.participant.actorId, b.participant.actorId))
      .map((actor) => initialActor(world, actor));
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
      state: { actors: actors.map((a) => displayActor(a, 0)), projectiles: [] },
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
                conditionMatches(a.definition.condition, selfView(actor, step, battle.rules.ai!)),
            );
            const budget = new ResourceBudget(actor.resources, actor.used);
            const reserved = budget.reserve(
              'startup',
              startup.map((a) => ({
                ...a.definition.costs,
                uses: { id: a.id, limit: a.definition.costs.uses },
              })),
            );
            if (!reserved.ok) {
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
            budget.commit('startup');
            const payment = budget.finish();
            actor.resources = payment.resources;
            actor.used = payment.used;
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
          commitEffects(next, effects, battle, journal, step, step, 'boundary', budget, world);
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
          commitEffects(next, periodic, battle, journal, step, step, 'boundary', budget, world);
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
        outcome = outcomeFromError(error);
        break;
      }
      try {
        const before = actors.map((a) => displayActor(a, step));
        const next = actors.map(cloneActor),
          attacks = melees.map((m) => ({ ...m }));
        let nextSerial = serial;
        const bullets = [...projectiles],
          spawns: ProjectileDisplay[] = [];
        const journal = new Journal(sequence, bytes, budget),
          effects: PendingEffect[] = [];
        const aiBoundary = step % (battle.manifest.physicsProfile.aiMs / battle.rules.stepMs) === 0;
        // Observe and choose before either participant pays or declares anything.
        for (const actor of next) {
          const enemy = actors.find((a) => actorId(a) !== actorId(actor))!;
          actor.memory = perceive(
            world,
            actor.motion,
            enemy.motion,
            projectiles.map((p) => ({
              ...p,
              radiusMm:
                p.ability.definition.attack.kind === 'projectile'
                  ? p.ability.definition.attack.radiusMm
                  : 0,
            })),
            step,
            actor.memory,
            {
              resources: enemy.resources,
              action: displayActor(enemy, step).action?.phase ?? 'idle',
            },
            battle.scenario.terrainKnowledge ?? 'observed',
            battle.rules.ai!,
          );
          if (actor.action && actor.action.recoveryUntil <= step) actor.action = null;
          const stats = effectiveStats(actor.motion.actor, actor.statuses, step);
          const view = selfView(actor, step, battle.rules.ai!);
          const flight =
            stats.flight &&
            canMaintainFlight(
              view.resources,
              view.flightStaminaPerSecond ?? 0,
              resourceReady(view),
            );
          const ready = new Set(
            actor.motion.actor.abilities
              .filter(
                (a) => a.definition.trigger === 'action' && (actor.cooldowns[a.id] ?? 0) <= step,
              )
              .map((a) => a.id),
          );
          if (actor.memory.learned.length || actor.memory.expired.length)
            journal.emit({
              kind: 'knowledge',
              step,
              phase: 'declaration',
              actorId: actorId(actor),
              ruleId: 'ai.observation',
              cognition: {
                kind: 'knowledge',
                perspective: 'subjective',
                learned: actor.memory.learned.map((e) => ({
                  ...e,
                  ability: { ...e.ability },
                  range: e.range ? { ...e.range } : null,
                })),
                expired: [...actor.memory.expired],
              },
            });
          const canMove =
            !stats.rooted &&
            !(
              actor.action &&
              step < actor.action.launchAt &&
              actor.action.ability.definition.movementWhileCasting === 'stop'
            );
          if (aiBoundary || actor.intent.flight !== flight) {
            const knownWorld =
              battle.scenario.terrainKnowledge === 'surveyed'
                ? null
                : knownTerrainWorld(actor.memory.terrain);
            if (knownWorld) knownWorld.castLimit = Math.max(0, world.castLimit - world.casts);
            try {
              const navigator = knownWorld
                ? new Navigator(
                    knownWorld,
                    actor.motion.actor,
                    {
                      ...battle.scenario,
                      obstacles: [],
                      navigation: { version: 'support-graph-v1', nodes: [], edges: [] },
                    },
                    battle.rules,
                    true,
                  )
                : navigators.get(actorId(actor))!;
              actor.decision = choosePolicy(
                view,
                aiBoundary ? ready : new Set(),
                flight,
                actor.decisionRandom,
                (from, to) => navigator.knownClearance(from, to),
              );
              actor.decisionRandom = actor.decision.random!;
              journal.emit({
                kind: 'decision',
                step,
                phase: 'declaration',
                actorId: actorId(actor),
                ruleId: 'ai.observed-utility',
                cognition: actor.decision.cognition!,
              });
              const steering = steerPolicy(view, actor.decision, navigator, {
                flight,
                canMove,
                speedBps: stats.speedBps,
                maxPathNodes: budget.maxPathNodes,
              });
              pathNodes += steering.navigation?.visited ?? 0;
              if (steering.navigation?.kind === 'budget-exceeded')
                throw new SpatialBudgetError('path-nodes');
              actor.intent = steering.intent;
            } finally {
              if (knownWorld) {
                world.casts += knownWorld.casts;
                knownWorld.free();
              }
            }
          }
          actor.intent = {
            ...actor.intent,
            canMove,
            speedBps: stats.speedBps,
            flight,
          };
        }
        const resourceBudgets = new Map(
          next.map((actor) => [
            actorId(actor),
            new ResourceBudget(
              actor.resources,
              actor.used,
              resourceReady(selfView(actor, step, battle.rules.ai!)),
            ),
          ]),
        );
        for (const actor of next) {
          const view = selfView(actor, step, battle.rules.ai!);
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
              const resources = resourceBudgets.get(actorId(actor))!;
              const payment = resources.reserve('action', [
                { ...definition.costs, uses: { id: ability.id, limit: definition.costs.uses } },
              ]);
              const silenced = !!view.silenced && blockedBySilence(definition);
              if (!inObservedRange(definition, view) || !payment.ok || silenced) {
                if (payment.ok) resources.cancel('action');
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
                  reason: !payment.ok
                    ? `insufficient-${payment.reason}`
                    : silenced
                      ? 'silenced'
                      : 'observed-range-or-facing',
                });
              } else {
                const paid = resources.commit('action');
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
                  after: { ...paid.after },
                });
                actor.resources = paid.after;
                actor.used = resources.finish().used;
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
            !inObservedRange(definition, selfView(actor, step, battle.rules.ai!)) ||
            !conditionMatches(definition.condition, selfView(actor, step, battle.rules.ai!)) ||
            (selfView(actor, step, battle.rules.ai!).silenced && blockedBySilence(definition))
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
          if (
            (definition.attack.kind === 'melee' || definition.attack.kind === 'projectile') &&
            muzzleBlocked(world, actor.motion)
          ) {
            journal.emit({
              kind: 'fizzle',
              step,
              phase: 'launch',
              actorId: actorId(actor),
              abilityId: action.ability.id,
              parentEventId: launch.id,
              ruleId: `${definition.attack.kind}.muzzle-blocked`,
            });
            continue;
          }
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
                effects.push(
                  ...effectsOf(actor, action.ability, actorId(enemy), hit.id, step).map(
                    (effect) => ({
                      ...effect,
                      observation: { self: actor.motion, target: enemy.motion },
                    }),
                  ),
                );
            }
          } else if (definition.attack.kind === 'melee') {
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
              ...damageSource(effectiveStats(actor.motion.actor, actor.statuses, step)),
              hits: 0,
            });
          } else if (definition.attack.kind === 'projectile') {
            const target = actor.memory.observation?.enemy ?? actor.memory.lastSeen;
            const projectile: ProjectileState = {
              id: `projectile.${action.id}`,
              ownerId: actorId(actor),
              ability: action.ability,
              cause: launch.id,
              launchStep: step,
              position: bodyPoint(actor.motion, actor.motion.actor.character.body.muzzleOffset),
              velocity: mul(aim.direction, definition.attack.speedMmPerSecond / 1000),
              ...damageSource(effectiveStats(actor.motion.actor, actor.statuses, step)),
              target: target ? { ...target.position } : null,
            };
            const spawn = journal.emit({
              kind: 'projectile-spawn',
              step,
              phase: 'launch',
              entityId: projectile.id,
              actorId: projectile.ownerId,
              abilityId: action.ability.id,
              parentEventId: launch.id,
              ruleId: 'projectile.spawn',
              point: projectile.position,
            });
            projectile.cause = spawn.id;
            bullets.push(projectile);
            peakProjectiles = Math.max(peakProjectiles, bullets.length);
            if (bullets.length > budget.maxProjectiles) throw new SpatialBudgetError('projectiles');
            spawns.push(displayProjectile(projectile));
          }
        }
        const motionPlans = next.map((actor) =>
          reserveMotion(
            actor,
            resourceBudgets.get(actorId(actor))!,
            step,
            aiBoundary && actor.decision.cognition?.selection === 'dodge',
          ),
        );
        for (const [index, actor] of next.entries()) actor.intent = motionPlans[index]!.intent;
        const moved = moveActors(
          world,
          next.map((a) => a.motion),
          new Map(next.map((a) => [actorId(a), a.intent])),
          battle.rules,
          budget.maxMoveSegments,
        );
        for (const [index, movement] of moved.entries())
          motionPlans[index]!.settle(movement, journal);
        const surviving: MeleeState[] = [];
        const projectileStep = stepProjectiles(
          bullets,
          next,
          moved,
          world,
          battle,
          budget,
          journal,
          step,
          () => {
            if (++candidates > budget.maxCandidates) throw new SpatialBudgetError('candidates');
          },
        );
        effects.push(...projectileStep.effects);
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
                  ...damageSource(attack),
                  parentEventId: hit.id,
                  abilityId: attack.ability.id,
                  observation: contactObservation(
                    moved,
                    next.find((a) => actorId(a) === attack.actorId)!.motion,
                    next.find((a) => actorId(a) !== attack.actorId)!.motion,
                    contact.time,
                  ),
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
        commitEffects(next, effects, battle, journal, step, step + 1, 'resolution', budget, world);
        for (const actor of next)
          recoverActorResources(actor, battle.rules.stepMs, step + 1, journal);
        const record: StreamRecord = {
          kind: 'interval',
          schemaVersion: 1,
          fromStep: step,
          toStep: step + 1,
          paths: [
            ...moved.map((m) => ({
              entityId: m.state.actor.participant.actorId,
              segments: m.trace,
            })),
            ...projectileStep.paths,
          ],
          projectiles: { ...projectileStep.changes, spawn: spawns },
          changes: displayChanges(
            before,
            next.map((a) => displayActor(a, step + 1)),
          ),
          events: journal.events,
        };
        const committed = journal.finish(record);
        actors = next;
        melees = surviving;
        projectiles = projectileStep.alive;
        serial = nextSerial;
        step++;
        bytes += committed.bytes;
        sequence += journal.events.length;
        yield structuredClone(record);
        outcome = verdict(actors);
      } catch (error) {
        outcome = outcomeFromError(error);
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
        candidates,
        pathNodes,
        peakProjectiles,
      },
    };
  } finally {
    world.free();
  }
}
