import type { DeepReadonly, Definition } from '@fantasy/domain/spatial';
import type { ActorState } from './combat-state.ts';
import type { DecisionView } from './perception.ts';
import { effectiveStats } from './status.ts';
import { damageAmounts } from './effects.ts';
import { damageSource } from './damage.ts';

/** Own resources and active statuses are proprioception, never a lookup of an opponent. */
export function selfView(
  actor: ActorState,
  step: number,
  rules: DeepReadonly<NonNullable<Definition<'ruleset'>['ai']>>,
): DecisionView {
  const stats = effectiveStats(actor.motion.actor, actor.statuses, step);
  const active = actor.statuses.filter((s) => s.startStep <= step && step < s.endStep);
  const burnDamage = active.reduce(
    (sum, s) =>
      sum +
      (s.revision.definition.burning
        ? s.revision.definition.periodic.reduce((damage, p) => {
            if (p.kind !== 'damage') return damage;
            const next =
              s.startStep + (Math.floor((step - s.startStep) / p.everySteps) + 1) * p.everySteps;
            const count = Math.max(
              0,
              Math.ceil((Math.min(step + rules.horizonSteps + 1, s.endStep) - next) / p.everySteps),
            );
            return (
              damage +
              Number(
                damageAmounts(
                  p.amount,
                  0,
                  0,
                  stats.defense,
                  actor.motion.actor.character.stats.resistances[p.element] ?? 0,
                ).afterResistance,
              ) *
                count *
                s.stacks
            );
          }, 0)
        : 0),
    0,
  );
  return {
    self: actor.motion,
    resources: actor.resources,
    memory: actor.memory,
    statusIds: active.map((s) => s.revision.id),
    step,
    used: actor.used,
    canAct: step >= actor.readyAt && !actor.action,
    canMove:
      !stats.rooted &&
      !(
        actor.action &&
        step < actor.action.launchAt &&
        actor.action.ability.definition.movementWhileCasting === 'stop'
      ),
    silenced: stats.silenced,
    speedBps: stats.speedBps,
    ...damageSource(stats),
    burnDamage: Math.max(0, burnDamage - actor.resources.shield),
    waterExtinguishable: active.some((s) => s.revision.definition.burning?.waterExtinguishable),
    rules,
  };
}
