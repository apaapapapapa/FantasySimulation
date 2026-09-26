import { revivalHp } from '@fantasy/domain/spatial/execution';
import type { EffectContext } from './combat-effects.ts';
import type { ActivatedReaction } from './reaction-activation.ts';
/** All owners have paid atomically before any revival; no healing/counter recursion. */
export function commitRevivals(reactions: readonly ActivatedReaction[], context: EffectContext) {
  for (const r of reactions) {
    if (r.response.kind !== 'revive') continue;
    const before = { ...r.actor.vitals.resources };
    const amount = revivalHp(r.response.health, r.actor.body.motion.actor.character.stats.hp);
    r.actor.vitals.resources.hp = amount;
    context.journal.emit({
      kind: 'revival',
      step: context.activationStep,
      phase: context.phase,
      actorId: r.display.targetId,
      targetId: r.display.targetId,
      abilityId: r.ability.id,
      parentEventId: r.display.context.activationId,
      reaction: r.display.context,
      ruleId: 'reaction.revive',
      amount,
      before,
      after: { ...r.actor.vitals.resources },
      revival: { use: r.actor.actions.used[r.ability.id]! },
      reason: 'after-all-waves; statuses-retained; explicit-hp-reset',
    });
  }
}
