import {
  effectiveStatuses,
  type BattleEvent,
  type DeepReadonly,
  type Effect,
} from '@fantasy/domain/spatial/execution';
import type { EffectTarget } from '../state.ts';

/** Evaluate contact requirements against one opening state, never newly applied statuses. */
export function defeatRequest(
  target: EffectTarget,
  effect: DeepReadonly<Extract<Effect, { kind: 'defeat' }>>,
  step: number,
): NonNullable<BattleEvent['defeat']> {
  if (target.resources.hp === 0) return { applied: false, reason: 'already-defeated' };
  const statuses = effectiveStatuses(target.statuses, step);
  if (statuses.some((status) => status.revision.definition.defeatImmunity))
    return { applied: false, reason: 'immune' };
  const condition = effect.requires;
  if (
    condition &&
    !(condition.kind === 'hp-at-most'
      ? BigInt(target.resources.hp) * 10000n <=
        BigInt(target.actor.character.stats.hp) * BigInt(condition.bps)
      : statuses.some((status) => status.revision.id === condition.id) === condition.present)
  )
    return { applied: false, reason: 'condition' };
  return { applied: true, reason: 'accepted' };
}

export function availableImmortality(target: EffectTarget, step: number) {
  if (
    target.resources.hp === 0 ||
    !target.statuses.some((status) => status.revision.definition.immortality)
  )
    return undefined;
  return effectiveStatuses(target.statuses, step).find(
    (status) =>
      (status.revision.definition.immortality?.protections ?? 0) > (target.immortalityUsed ?? 0),
  );
}
