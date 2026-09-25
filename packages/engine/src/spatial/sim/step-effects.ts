import type { ActorState, AbilityRevision } from '../state.ts';
import { type StageContact } from '@fantasy/domain/spatial/execution';
import { type PendingEffect } from '../combat-effects.ts';
import { statusDamageSource } from '../status-damage.ts';
import { actorId } from './step-transaction.ts';
export function effectsOf(
  actor: ActorState,
  ability: AbilityRevision,
  targetId: string,
  parentEventId: string,
  step: number,
  stage?: StageContact,
): PendingEffect[] {
  const source = statusDamageSource(actor, ability, step);
  return ability.definition.effects.map((effect) => ({
    actorId: actorId(actor),
    targetId,
    effect,
    ...source,
    parentEventId,
    abilityId: ability.id,
    ...(stage ? { stage } : {}),
  }));
}
