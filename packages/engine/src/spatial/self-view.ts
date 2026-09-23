import type { DeepReadonly, Definition } from '@fantasy/domain/spatial';
import type { ActorState } from './combat-state.ts';
import type { DecisionView } from './perception.ts';
import {
  effectiveStats,
  periodicPulseCount,
  statusKnowledge,
  type StatusRevision,
} from './status.ts';
import { calculateDamage, damageSource } from './damage.ts';
import { damageStatusBps, statusResistance } from './status-modifiers.ts';
import { reactionDamageBps, statusReactions } from './status-reactions.ts';
import { generalizedStatus } from './status-observation.ts';
import { flightRate } from './locomotion.ts';

/** Own resources and active statuses are proprioception, never a lookup of an opponent. */
export function selfView(
  actor: Pick<
    ActorState,
    'motion' | 'statuses' | 'resources' | 'memory' | 'used' | 'readyAt' | 'action' | 'staminaClock'
  >,
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
  const burnDamage = active.reduce(
    (sum, s) =>
      sum +
      (s.revision.definition.burning || generalizedStatus(s.revision.definition)
        ? s.revision.definition.periodic.reduce((damage, p) => {
            if (p.kind !== 'damage') return damage;
            const count = periodicPulseCount(
              s.startStep,
              p.everySteps,
              step + 1,
              Math.min(step + rules.horizonSteps + 1, s.endStep),
            );
            return (
              damage +
              Number(
                calculateDamage(
                  { kind: 'damage', amount: p.amount, attackScaleBps: 0, element: p.element },
                  { attack: 0 },
                  {
                    ...stats,
                    resistance: statusResistance(
                      actor.motion.actor.character.stats.resistances,
                      active,
                      step,
                      p.element,
                    ),
                  },
                  10000,
                  {
                    receivedBps: damageStatusBps(
                      'damageTaken',
                      active,
                      step,
                      { element: p.element },
                      reactionDamageBps(active, step, p.element),
                    ),
                  },
                ).afterModifiers,
              ) *
                count *
                s.stacks
            );
          }, 0)
        : 0),
    0,
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
    ownStatuses: active,
    incapacitated: stats.incapacitated,
    canAct: step >= actor.readyAt && !actor.action && !stats.incapacitated,
    canMove:
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
    burnDamage: Math.max(0, burnDamage - actor.resources.shield),
    waterExtinguishable: active.some((s) =>
      statusReactions(s.revision.definition).some(
        (r) => r.element === 'water' && r.response.kind === 'remove',
      ),
    ),
    rules,
  };
}
