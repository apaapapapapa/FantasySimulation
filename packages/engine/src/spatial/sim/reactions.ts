import type { ProjectileContacts } from './projectile-deflection.ts';
import type { ActorState } from '../state.ts';
import type { BattleEvent } from '@fantasy/domain/spatial/execution';
import {
  commitEffects,
  commitTransactionStatuses,
  type PendingEffect,
  type EffectContext,
} from './combat-effects.ts';
import type { Journal } from '../rules/journal.ts';
import {
  activateReactions,
  ReactionBudget,
  type ReactionActivationState,
  type ReactionWork,
} from './reaction-activation.ts';
import {
  beforeHitApplications,
  positiveDamageApplications,
  reactionApplications,
} from './reaction-phases.ts';
export { ReactionBudget, type ReactionWork } from './reaction-activation.ts';
export { reactionPayload } from './reaction-phases.ts';

const idOf = (actor: ActorState) => actor.body.motion.actor.participant.actorId;
export function cancelDeadCounters(
  actors: ActorState[],
  journal: Journal,
  step: number,
  phase: BattleEvent['phase'],
) {
  for (const actor of actors)
    for (const reaction of actor.actions.reactions ?? [])
      if (actor.vitals.resources.hp === 0 && reaction.state === 'queued') {
        reaction.state = 'cancelled';
        journal.emit({
          kind: 'reaction',
          step,
          phase,
          actorId: idOf(actor),
          abilityId: reaction.abilityId,
          targetId: reaction.targetId,
          parentEventId: reaction.context.activationId,
          reaction: reaction.context,
          ruleId: 'reaction.cancelled',
          reason: 'owner-defeated; paid cost retained',
        });
      }
}

/** Fixed phase order inside one StepTransaction. No phase publishes a record or
 * owns rollback: the caller commits actors, PRNG, hit ledger and journal together.
 */
export function commitReactiveEffects(
  actors: ActorState[],
  effects: PendingEffect[],
  context: EffectContext,
  work: ReactionWork,
  projectileContacts?: ProjectileContacts,
) {
  const { journal, step, activationStep, phase, budget } = context;
  if (!actors.some((a) => a.body.motion.actor.abilities.some((b) => b.definition.reaction))) {
    commitEffects(actors, effects, context);
    return;
  }
  const alive =
    context.aliveAtStart ?? new Set(actors.filter((a) => a.vitals.resources.hp > 0).map(idOf));
  const limit = new ReactionBudget(
    budget,
    actors.reduce(
      (sum, a) =>
        sum +
        a.body.motion.actor.abilities
          .filter((b) => b.definition.reaction)
          .reduce((n, b) => n + (a.actions.used[b.id] ?? 0), 0),
      0,
    ),
    work,
  );
  const admission: ReactionActivationState = { context, alive, limit };
  const all: ReturnType<typeof commitEffects>['applications'] = [];
  const wave = (pending: PendingEffect[], index = 0) => {
    const result = commitEffects(actors, pending, context, true, index);
    all.push(...result.applications);
    return result;
  };

  const incoming = projectileContacts?.plan(effects, actors, context) ?? effects;
  const before = activateReactions(actors, incoming, 'before-hit', 0, admission);
  if (projectileContacts) effects = [...effects, ...projectileContacts.finish(before)];
  const primary = wave(beforeHitApplications(actors, effects, before, step));
  const positive = positiveDamageApplications(primary);
  const after = activateReactions(actors, positive, 'after-damage', 0, admission);
  const afterEffects = reactionApplications(
    after.filter((reaction) => reaction.response.kind === 'effects'),
    step,
  );
  if (afterEffects.length) wave(afterEffects, 1);

  const defeated = activateReactions(
    actors,
    all.map((app) => ({ ...app, parentEventId: app.id })),
    'before-defeat',
    afterEffects.length ? 1 : 0,
    admission,
  );
  const defeatEffects = reactionApplications(defeated, step);
  if (defeatEffects.length) wave(defeatEffects, afterEffects.length ? 2 : 1);
  commitTransactionStatuses(actors, all, context);
  cancelDeadCounters(actors, journal, activationStep, phase);
}
