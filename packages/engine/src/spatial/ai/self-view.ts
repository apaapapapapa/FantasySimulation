import type { ActorState, DecisionView, StatusRevision } from '../state.ts';
import profile from '../profile.json' with { type: 'json' };
import type { DeepReadonly, Definition } from '@fantasy/domain/spatial/execution';
import { effectiveStats, statusKnowledge } from '../rules/status.ts';
import { damageSource } from '../rules/damage.ts';
import { statusReactions } from '../rules/status-reactions.ts';
import { knownPeriodicDamage } from '../rules/status-risk.ts';
import { flightRate } from '../rules/locomotion.ts';
import { hasForcedMotion } from '../rules/forces.ts';
import { ownsStageMotion } from '../rules/stage-motion.ts';
import { postureSpeed } from '../rules/posture.ts';

/** Own resources and active statuses are proprioception, never a lookup of an opponent. */
export function selfView(
  actor: ActorState,
  step: number,
  rules: DeepReadonly<NonNullable<Definition<'ruleset'>['ai']>>,
  definitions: readonly StatusRevision[],
  gravityMmPerSecond2 = profile.gravityMmPerSecond2,
): DecisionView {
  const stats = effectiveStats(actor.body.motion.actor, actor.statuses, step);
  const active = actor.statuses.filter((s) => s.startStep <= step && step < s.endStep);
  const known = actor.body.motion.actor.knownStatuses ?? [];
  const knowledge = statusKnowledge([...known, ...active.map((s) => s.revision)], definitions);
  const self =
    knowledge.length === known.length && knowledge.every((s, i) => s === known[i])
      ? actor.body.motion
      : { ...actor.body.motion, actor: { ...actor.body.motion.actor, knownStatuses: knowledge } };
  const burnDamage = knownPeriodicDamage(
    self.actor,
    active,
    actor.vitals.resources,
    step,
    rules.horizonSteps,
  );
  return {
    self,
    resources: actor.vitals.resources,
    staminaExhausted: actor.vitals.staminaClock?.exhausted ?? false,
    flightStaminaPerSecond: stats.flight ? flightRate(actor.statuses, step) : 0,
    memory: actor.mind.memory,
    statusIds: active.map((s) => s.revision.id),
    step,
    gravityMmPerSecond2,
    used: actor.actions.used,
    reactionReadyAt: actor.actions.cooldowns,
    ownStatuses: active,
    incapacitated: stats.incapacitated,
    canAct: step >= actor.actions.readyAt && !actor.actions.action && !stats.incapacitated,
    activeAbility: actor.actions.action?.ability.definition,
    stageOwnsMotion: ownsStageMotion(actor.actions.action, step),
    canMove:
      !hasForcedMotion(actor.body, step) &&
      !stats.rooted &&
      !stats.incapacitated &&
      !(
        actor.actions.action &&
        step < actor.actions.action.launchAt &&
        actor.actions.action.ability.definition.movementWhileCasting === 'stop'
      ),
    silenced: stats.silenced,
    speedBps: Math.floor((stats.speedBps * postureSpeed(actor.body.motion)) / 10000),
    ...damageSource(stats),
    magicPower: stats.magicPower ?? stats.attack,
    burnDamage,
    waterExtinguishable: active.some((s) =>
      statusReactions(s.revision.definition).some(
        (r) => r.element === 'water' && r.response.kind === 'remove',
      ),
    ),
    rules,
  };
}
