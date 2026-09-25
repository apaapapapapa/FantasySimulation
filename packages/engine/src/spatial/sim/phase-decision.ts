import { displayActor } from '../combat-state.ts';
import { canMaintainFlight, resourceReady } from '../locomotion.ts';
import { Navigator } from '../navigation.ts';
import { knownTerrainWorld } from '../known-terrain.ts';
import { selfView } from '../self-view.ts';
import { perceive } from '../perception.ts';
import { choosePolicy, steerPolicy } from '../policy.ts';
import { effectiveStats } from '../status.ts';
import { statusVision, copyPublicStatuses } from '../status-observation.ts';
import { checkStageInterruption, visibleStageCue } from '../stages.ts';
import { beginForcedInterval } from '../forces.ts';
import { visibleReactionCue } from '../reaction-assessment.ts';
import { advancePosture, postureAllows, postureSpeed } from '../posture.ts';
import { type StepTransaction, actorId } from './step-transaction.ts';
export function decisionPhase(tx: StepTransaction) {
  const { battle, budget, world, work } = tx.context;
  const { navigators } = tx.context;
  const { step, journal, aiBoundary } = tx;
  const actors = tx.previous.actors,
    next = tx.next.actors,
    projectiles = tx.previous.projectiles;
  const forcePlans = new Map(
    next.map((actor) => {
      delete actor.intent.forced;
      delete actor.intent.authored;
      return [
        actorId(actor),
        beginForcedInterval(actor, step, battle.rules.forcedSpeedCapMmPerSecond),
      ];
    }),
  );
  tx.previousMovement = new Map(
    next.map((actor) => [
      actorId(actor),
      { intent: { ...actor.intent }, decision: actor.decision },
    ]),
  );
  // Observe and choose before either participant pays or declares anything.
  for (const actor of next) {
    const enemy = actors.find((a) => actorId(a) !== actorId(actor))!;
    const previousStatuses = actor.memory.observation?.enemy?.statuses;
    actor.motion = statusVision(actor.motion, actor.statuses, step);
    actor.memory = perceive(
      world,
      actor.motion,
      statusVision(enemy.motion, enemy.statuses, step),
      projectiles.map((p) => ({
        ...p,
        radiusMm:
          p.ability.definition.attack.kind === 'projectile'
            ? p.ability.definition.attack.radiusMm
            : 0,
        ...(battle.rules.ai.reapplication
          ? {
              element: p.ability.definition.effects.find((e) => e.kind === 'damage')?.element,
              attackCueId: p.cause,
            }
          : {}),
      })),
      step,
      actor.memory,
      {
        resources: enemy.resources,
        statuses: enemy.statuses,
        action: displayActor(enemy, step).action?.phase ?? 'idle',
        stage: visibleStageCue(enemy, step),
        reaction: visibleReactionCue(enemy, step),
      },
      battle.scenario.terrainKnowledge,
      battle.rules.ai,
      battle.scenario.bounds,
    );
    if (actor.action && actor.action.recoveryUntil <= step) actor.action = null;
    const stats = effectiveStats(actor.motion.actor, actor.statuses, step);
    const view = {
      ...selfView(actor, step, battle.rules.ai, battle.statuses),
      gravityMmPerSecond2: battle.rules.gravityMmPerSecond2,
    };
    checkStageInterruption(actor, view, step, journal, 'declaration');
    const flight =
      stats.flight &&
      canMaintainFlight(view.resources, view.flightStaminaPerSecond, resourceReady(view));
    const ready = new Set(
      actor.motion.actor.abilities
        .filter((a) => a.definition.trigger === 'action' && (actor.cooldowns[a.id] ?? 0) <= step)
        .map((a) => a.id),
    );
    const seen = actor.memory.observation?.enemy;
    const newStatuses = seen?.statuses;
    const changedStatuses =
      newStatuses !== undefined && JSON.stringify(newStatuses) !== JSON.stringify(previousStatuses);
    if (actor.memory.learned.length || actor.memory.expired.length || changedStatuses)
      journal.emit({
        kind: 'knowledge',
        step,
        phase: 'declaration',
        actorId: actorId(actor),
        ruleId: 'ai.observation',
        cognition: {
          kind: 'knowledge',
          perspective: 'subjective',
          learned: actor.memory.learned.map(({ observedStatuses, ...e }) => ({
            ...e,
            ability: { ...e.ability },
            range: e.range ? { ...e.range } : null,
            ...(observedStatuses && {
              observedStatuses: copyPublicStatuses(observedStatuses),
            }),
          })),
          expired: [...actor.memory.expired],
          ...(changedStatuses &&
            seen && {
              statusObservation: {
                targetId: seen.id,
                sampledAt: seen.step,
                availableAt: actor.memory.observation!.availableAt,
                statuses: copyPublicStatuses(newStatuses),
              },
            }),
        },
      });
    const canMove =
      !forcePlans.get(actorId(actor))?.active &&
      !stats.rooted &&
      !stats.incapacitated &&
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
          : actor.motion.posture
            ? new Navigator(world, actor.motion.actor, battle.scenario, battle.rules)
            : navigators.get(actorId(actor))!;
        actor.decision = choosePolicy(
          view,
          aiBoundary ? ready : new Set(),
          flight,
          actor.decisionRandom,
          (from, to, body) => navigator.knownClearance(from, to, body),
          battle.rules.ai.search
            ? {
                bounds: battle.scenario.bounds,
                obstacles: (knownWorld ?? world).obstacles('vision'),
                blocked: (from, to, layer) => (knownWorld ?? world).occluded(from, to, layer),
              }
            : undefined,
        );
        actor.decisionRandom = actor.decision.random!;
        if (actor.decision.search)
          actor.memory = { ...actor.memory, search: actor.decision.search };
        const requestedAbility =
          actor.action?.ability ??
          actor.motion.actor.abilities.find((a) => a.id === actor.decision.abilityId);
        const requestedPosture = actor.decision.posture;
        if (
          !view.stageOwnsMotion &&
          view.canMove &&
          (!requestedAbility ||
            !actor.motion.posture ||
            !requestedPosture ||
            postureAllows(
              {
                ...actor.motion,
                posture: { ...actor.motion.posture, current: requestedPosture },
              },
              requestedAbility.definition,
            ))
        )
          actor.motion = advancePosture(
            actor.motion,
            requestedPosture,
            step,
            world,
            actors.map((a) => a.motion),
            actor.decision.postureUntil,
          );
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
          speedBps: Math.floor((stats.speedBps * postureSpeed(actor.motion)) / 10000),
          maxPathNodes: budget.maxPathNodes,
        });
        work.recordNavigation(steering.navigation);
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
      speedBps: Math.floor((stats.speedBps * postureSpeed(actor.motion)) / 10000),
      flight,
    };
  }

  tx.forcePlans = forcePlans;
}
