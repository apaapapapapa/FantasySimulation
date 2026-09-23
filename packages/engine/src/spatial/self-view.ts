import type { DeepReadonly, Definition } from '@fantasy/domain/spatial';
import type { ActorState } from './combat-state.ts';
import type { DecisionView } from './perception.ts';
import { effectiveStats, statusKnowledge, type StatusRevision } from './status.ts';
import { damageSource } from './damage.ts';
import { statusReactions } from './status-reactions.ts';
import { knownPeriodicDamage } from './status-risk.ts';
import { flightRate } from './locomotion.ts';
import { hasForcedMotion } from './forces.ts';
import { ownsStageMotion } from './stage-motion.ts';

/** Own resources and active statuses are proprioception, never a lookup of an opponent. */
export function selfView(
  actor: Pick<
    ActorState,
    | 'motion'
    | 'statuses'
    | 'resources'
    | 'memory'
    | 'used'
    | 'readyAt'
    | 'action'
    | 'staminaClock'
    | 'forces'
  > &
    Partial<Pick<ActorState, 'cooldowns'>>,
  step: number,
  rules: DeepReadonly<NonNullable<Definition<'ruleset'>['ai']>>,
  definitions: readonly StatusRevision[],
): DecisionView {
  const stats = effectiveStats(actor.motion.actor, actor.statuses, step);
  const active = actor.statuses.filter((s) => s.startStep <= step && step < s.endStep);
  const known = actor.motion.actor.knownStatuses ?? [];
  const knowledge = statusKnowledge([...known, ...active.map((s) => s.revision)], definitions);
  const self =
    knowledge.length === known.length && knowledge.every((s, i) => s === known[i])
      ? actor.motion
      : { ...actor.motion, actor: { ...actor.motion.actor, knownStatuses: knowledge } };
  const burnDamage = knownPeriodicDamage(
    self.actor,
    active,
    actor.resources,
    step,
    rules.horizonSteps,
  );
  return {
    self,
    resources: actor.resources,
    ...(actor.staminaClock ? { staminaExhausted: actor.staminaClock.exhausted } : {}),
    ...(stats.flight && flightRate(actor.statuses, step) > 0
      ? { flightStaminaPerSecond: flightRate(actor.statuses, step) }
      : {}),
    memory: actor.memory,
    statusIds: active.map((s) => s.revision.id),
    step,
    used: actor.used,
    ...(actor.motion.actor.abilities.some((a) => a.definition.reaction)
      ? { reactionReadyAt: actor.cooldowns ?? {} }
      : {}),
    ownStatuses: active,
    incapacitated: stats.incapacitated,
    canAct: step >= actor.readyAt && !actor.action && !stats.incapacitated,
    ...(ownsStageMotion(actor.action, step) ? { stageOwnsMotion: true } : {}),
    canMove:
      !hasForcedMotion(actor, step) &&
      !stats.rooted &&
      !stats.incapacitated &&
      !(
        actor.action &&
        step < actor.action.launchAt &&
        actor.action.ability.definition.movementWhileCasting === 'stop'
      ),
    silenced: stats.silenced,
    speedBps: stats.speedBps,
    ...damageSource(stats),
    ...(burnDamage === undefined ? {} : { burnDamage }),
    waterExtinguishable: active.some((s) =>
      statusReactions(s.revision.definition).some(
        (r) => r.element === 'water' && r.response.kind === 'remove',
      ),
    ),
    rules,
  };
}
