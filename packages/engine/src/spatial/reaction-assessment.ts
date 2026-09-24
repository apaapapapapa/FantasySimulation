import { compareIds, type ReactionEstimate, type ObservedReaction } from '@fantasy/domain/spatial';
import type { ActorState } from './combat-state.ts';
import { assessAbility, boundedWeight } from './assessment.ts';
import { conditionMatches, type DecisionView } from './perception.ts';
import { blockedBySilence } from './categories.ts';
import { postureAllows } from './posture.ts';
import { payCost } from './attacks.ts';
import { resourceReady } from './locomotion.ts';

/** Own reactions are automatic, never selectable main-action candidates or prepaid holds. */
export function assessReactions(view: DecisionView) {
  const estimates: ReactionEstimate[] = [];
  const reserve = { hp: 0, mp: 0, stamina: 0 };
  const observed = view.memory.observation;
  const threat =
    !!observed?.projectiles.length ||
    observed?.enemy?.action === 'cast' ||
    observed?.enemy?.action === 'active';
  for (const ability of [...view.self.actor.abilities].sort((a, b) => compareIds(a.id, b.id))) {
    const d = ability.definition,
      reaction = d.reaction;
    if (!reaction || d.trigger === 'action' || d.trigger === 'battle-start') continue;
    const used = view.used?.[ability.id] ?? 0;
    const readyAt = view.reactionReadyAt?.[ability.id] ?? 0;
    const payment = payCost(d, view.resources, used, resourceReady(view));
    const reason = !postureAllows(view.self, d)
      ? 'posture'
      : view.incapacitated
        ? 'incapacitated'
        : view.silenced && blockedBySilence(d)
          ? 'silenced'
          : readyAt > (view.step ?? 0)
            ? 'cooldown-or-recovery'
            : !payment.ok
              ? `insufficient-${payment.reason}`
              : !view.self.actor.character.stats.actionSpeedBps
                ? 'action-speed'
                : !conditionMatches(d.condition, view)
                  ? 'condition'
                  : 'automatic-trigger; estimate only';
    const eligible = reason === 'automatic-trigger; estimate only';
    const assessment = assessAbility(view, ability);
    if (reaction.response.kind === 'parry') {
      assessment.weight = threat
        ? boundedWeight((view.rules?.actionWeight ?? 100) / (1 + assessment.costBps / 5000))
        : 0;
      assessment.successBps = threat ? 5000 : 0;
      assessment.confidenceBps = 1000;
      assessment.reason =
        'own parry/filter/cost; delayed visible threat; contact and eligibility uncertain';
    } else {
      assessment.confidenceBps = Math.min(1000, assessment.confidenceBps);
      assessment.reason = `automatic ${d.trigger}; ${assessment.reason}`.slice(0, 300);
    }
    if (eligible && threat && assessment.weight > 0)
      for (const key of ['hp', 'mp', 'stamina'] as const)
        reserve[key] = Math.min(view.resources[key] ?? 0, reserve[key] + (d.costs[key] ?? 0));
    estimates.push({
      abilityId: ability.id,
      point: d.trigger,
      response: reaction.response.kind,
      readyAt,
      remainingUses: d.costs.uses ? Math.max(0, d.costs.uses - used) : null,
      eligible,
      reason,
      assessment,
    });
  }
  return { estimates, reserve };
}
/** Public cue of an actual activation only. Never expose costs, IDs, clocks or a pending queue. */
export function visibleReactionCue(actor: ActorState, step: number): ObservedReaction | undefined {
  const active = (actor.reactions ?? [])
    .filter((r) => r.activatedAt <= step && step < r.recoveryUntil && r.state !== 'cancelled')
    .sort((a, b) => b.activatedAt - a.activatedAt || compareIds(a.abilityId, b.abilityId))[0];
  if (!active) return undefined;
  const ability = actor.motion.actor.abilities.find((a) => a.id === active.abilityId)!;
  return { point: active.context.point, response: ability.definition.reaction!.response.kind };
}
