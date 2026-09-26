import { terrainObstacles } from '../world/terrain.ts';
import { opponentInDuel } from './duel.ts';
import { displayActor } from './combat-state.ts';
import { canMaintainFlight, resourceReady } from '../rules/locomotion.ts';
import { Navigator } from '../world/navigation.ts';
import { knownTerrainWorld } from '../world/known-terrain.ts';
import { selfView } from '../ai/self-view.ts';
import { perceive } from '../ai/perception.ts';
import { choosePolicy, steerPolicy } from '../ai/policy.ts';
import { effectiveStats } from '../rules/status.ts';
import { statusVision, copyPublicStatuses } from '../rules/status-observation.ts';
import { checkStageInterruption, visibleStageCue } from '../rules/stages.ts';
import { beginForcedInterval } from '../rules/forces.ts';
import { visibleReactionCue } from '../ai/reaction-assessment.ts';
import { advancePosture, postureAllows, postureSpeed } from '../rules/posture.ts';
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
      delete actor.body.intent.forced;
      delete actor.body.intent.authored;
      return [
        actorId(actor),
        beginForcedInterval(actor, step, battle.rules.forcedSpeedCapMmPerSecond),
      ];
    }),
  );
  tx.previousMovement = new Map(
    next.map((actor) => [
      actorId(actor),
      { intent: { ...actor.body.intent }, decision: actor.mind.decision },
    ]),
  );
  // Observe and choose before either participant pays or declares anything.
  for (const actor of next) {
    const enemy = opponentInDuel(actors, actorId(actor), actorId);
    const previousStatuses = actor.mind.memory.observation?.enemy?.statuses;
    actor.body.motion = statusVision(actor.body.motion, actor.statuses, step);
    actor.mind.memory = perceive(
      world,
      actor.body.motion,
      statusVision(enemy.body.motion, enemy.statuses, step),
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
      actor.mind.memory,
      {
        resources: enemy.vitals.resources,
        statuses: enemy.statuses,
        action: displayActor(enemy, step).action?.phase ?? 'idle',
        stage: visibleStageCue(enemy, step),
        reaction: visibleReactionCue(enemy, step),
      },
      battle.scenario.terrainKnowledge,
      battle.rules.ai,
      battle.scenario.bounds,
    );
    if (actor.actions.action && actor.actions.action.recoveryUntil <= step)
      actor.actions.action = null;
    const stats = effectiveStats(actor.body.motion.actor, actor.statuses, step);
    const view = {
      ...selfView(actor, step, battle.rules.ai, battle.statuses),
      gravityMmPerSecond2: battle.rules.gravityMmPerSecond2,
    };
    checkStageInterruption(actor, view, step, journal, 'declaration');
    const flight =
      stats.flight &&
      canMaintainFlight(view.resources, view.flightStaminaPerSecond, resourceReady(view));
    const ready = new Set(
      actor.body.motion.actor.abilities
        .filter(
          (a) => a.definition.trigger === 'action' && (actor.actions.cooldowns[a.id] ?? 0) <= step,
        )
        .map((a) => a.id),
    );
    const seen = actor.mind.memory.observation?.enemy;
    const newStatuses = seen?.statuses;
    const changedStatuses =
      newStatuses !== undefined && JSON.stringify(newStatuses) !== JSON.stringify(previousStatuses);
    if (actor.mind.memory.learned.length || actor.mind.memory.expired.length || changedStatuses)
      journal.emit({
        kind: 'knowledge',
        step,
        phase: 'declaration',
        actorId: actorId(actor),
        ruleId: 'ai.observation',
        cognition: {
          kind: 'knowledge',
          perspective: 'subjective',
          learned: actor.mind.memory.learned.map(({ observedStatuses, ...e }) => ({
            ...e,
            ability: { ...e.ability },
            range: e.range ? { ...e.range } : null,
            ...(observedStatuses && {
              observedStatuses: copyPublicStatuses(observedStatuses),
            }),
          })),
          expired: [...actor.mind.memory.expired],
          ...(changedStatuses &&
            seen && {
              statusObservation: {
                targetId: seen.id,
                sampledAt: seen.step,
                availableAt: actor.mind.memory.observation!.availableAt,
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
        actor.actions.action &&
        step < actor.actions.action.launchAt &&
        actor.actions.action.ability.definition.movementWhileCasting === 'stop'
      );
    if (aiBoundary || actor.body.intent.flight !== flight) {
      const knownWorld =
        battle.scenario.terrainKnowledge === 'surveyed' &&
        !tx.next.objects?.length &&
        !actor.mind.memory.terrain.length
          ? null
          : knownTerrainWorld(
              actor.mind.memory.terrain,
              battle.scenario.terrainKnowledge === 'surveyed'
                ? terrainObstacles(battle.scenario)
                : [],
            );
      if (knownWorld) knownWorld.castLimit = Math.max(0, world.castLimit - world.casts);
      try {
        const navigator = knownWorld
          ? new Navigator(
              knownWorld,
              actor.body.motion.actor,
              {
                ...battle.scenario,
                obstacles: [],
                navigation: { version: 'support-graph-v1', nodes: [], edges: [] },
              },
              battle.rules,
              true,
            )
          : actor.body.motion.posture
            ? new Navigator(world, actor.body.motion.actor, battle.scenario, battle.rules)
            : navigators.get(actorId(actor))!;
        actor.mind.decision = choosePolicy(
          view,
          aiBoundary ? ready : new Set(),
          flight,
          actor.mind.decisionRandom,
          (from, to, body) => navigator.knownClearance(from, to, body),
          battle.rules.ai.search
            ? {
                bounds: battle.scenario.bounds,
                obstacles: (knownWorld ?? world).obstacles('vision'),
                blocked: (from, to, layer) => (knownWorld ?? world).occluded(from, to, layer),
              }
            : undefined,
        );
        actor.mind.decisionRandom = actor.mind.decision.random!;
        if (actor.mind.decision.search)
          actor.mind.memory = { ...actor.mind.memory, search: actor.mind.decision.search };
        const requestedAbility =
          actor.actions.action?.ability ??
          actor.body.motion.actor.abilities.find((a) => a.id === actor.mind.decision.abilityId);
        const requestedPosture = actor.mind.decision.posture;
        if (
          !view.stageOwnsMotion &&
          view.canMove &&
          (!requestedAbility ||
            !actor.body.motion.posture ||
            !requestedPosture ||
            postureAllows(
              {
                ...actor.body.motion,
                posture: { ...actor.body.motion.posture, current: requestedPosture },
              },
              requestedAbility.definition,
            ))
        )
          actor.body.motion = advancePosture(
            actor.body.motion,
            requestedPosture,
            step,
            world,
            actors.map((a) => a.body.motion),
            actor.mind.decision.postureUntil,
          );
        journal.emit({
          kind: 'decision',
          step,
          phase: 'declaration',
          actorId: actorId(actor),
          ruleId: 'ai.observed-utility',
          cognition: actor.mind.decision.cognition!,
        });
        const steering = steerPolicy(view, actor.mind.decision, navigator, {
          flight,
          canMove,
          speedBps: Math.floor((stats.speedBps * postureSpeed(actor.body.motion)) / 10000),
          maxPathNodes: budget.maxPathNodes,
        });
        work.recordNavigation(steering.navigation);
        actor.body.intent = steering.intent;
      } finally {
        if (knownWorld) {
          world.casts += knownWorld.casts;
          knownWorld.free();
        }
      }
    }
    actor.body.intent = {
      ...actor.body.intent,
      canMove,
      speedBps: Math.floor((stats.speedBps * postureSpeed(actor.body.motion)) / 10000),
      flight,
    };
  }

  tx.forcePlans = forcePlans;
}
