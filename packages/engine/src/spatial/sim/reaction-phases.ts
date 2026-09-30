import type { ActorState, AbilityRevision } from '../state.ts';
import type { ReactionDisplay } from '@fantasy/domain/spatial/execution';
import { statusDamageSource } from '../rules/status-damage.ts';
import type { PendingEffect } from './combat-effects.ts';
import { matchesReaction, type ActivatedReaction } from './reaction-activation.ts';

export function reactionPayload(
  actor: ActorState,
  ability: AbilityRevision,
  reaction: ReactionDisplay,
  parent: string,
  step: number,
): PendingEffect[] {
  return ability.definition.effects.map((effect) => ({
    actorId: actor.body.motion.actor.participant.actorId,
    targetId: reaction.targetId,
    abilityId: ability.id,
    parentEventId: parent,
    reaction: reaction.context,
    effect,
    ...statusDamageSource(actor, ability, step),
  }));
}

/** The pre-hit reducer does not commit HP or statuses. Whole-contact parry and
 * damage-only parry retain their distinct causal/elemental semantics.
 */
export function beforeHitApplications(
  actors: ActorState[],
  effects: PendingEffect[],
  reactions: ActivatedReaction[],
  step: number,
): PendingEffect[] {
  const cancelled = new Set<PendingEffect>();
  const damageCancelled = new Map<PendingEffect, string[]>();
  const guards = new Map<PendingEffect, { activationId: string; retainedDamageBps: number }[]>();
  const extra: PendingEffect[] = [];
  for (const reaction of reactions) {
    const response = reaction.response;
    if (response.kind === 'deflect') continue;
    if (response.kind === 'parry' || response.kind === 'guard') {
      for (const matched of reaction.matches) {
        const contact = effects.filter(
          (app) =>
            app.actorId === matched.actorId &&
            app.targetId === matched.targetId &&
            app.abilityId === matched.abilityId &&
            (app.parentEventId === matched.parentEventId ||
              (!!app.projectileContact &&
                app.projectileContact.id === matched.projectileContact?.id)),
        );
        for (const app of contact)
          if (response.kind === 'parry' && response.scope === 'all') cancelled.add(app);
          else if (app.effect.kind === 'damage' && matchesReaction(reaction.ability, app, actors)) {
            if (response.kind === 'parry')
              damageCancelled.set(app, [
                ...(damageCancelled.get(app) ?? []),
                reaction.display.context.activationId,
              ]);
            else
              guards.set(
                app,
                (guards.get(app) ?? []).some(
                  (guard) => guard.activationId === reaction.display.context.activationId,
                )
                  ? guards.get(app)!
                  : [
                      ...(guards.get(app) ?? []),
                      {
                        activationId: reaction.display.context.activationId,
                        retainedDamageBps: response.retainedDamageBps,
                      },
                    ],
              );
          }
      }
    } else
      extra.push(
        ...reactionPayload(
          reaction.actor,
          reaction.ability,
          reaction.display,
          reaction.display.context.activationId,
          step,
        ),
      );
  }
  return [
    ...effects
      .filter((app) => !cancelled.has(app))
      .map((app) => {
        const cancelledCauses = damageCancelled.get(app) ?? [];
        const appliedGuards = guards.get(app) ?? [];
        const causes = [...cancelledCauses, ...appliedGuards.map((guard) => guard.activationId)];
        return causes.length
          ? {
              ...app,
              ...(cancelledCauses.length && { damageCancelled: true }),
              ...(appliedGuards.length && { guards: appliedGuards }),
              causes: [...(app.causes ?? []), ...causes],
            }
          : app;
      }),
    ...extra,
  ];
}

export type ResolvedDamageWave = {
  applications: readonly (PendingEffect & { id: string })[];
  resolved: readonly {
    damage: readonly { applicationId: string; toHp: { numerator: string } }[];
  }[];
};
/** Post-shield rational attribution, not net HP movement after simultaneous healing.
 * Future reflection/absorption must introduce their own explicit basis, not reuse
 * this after-damage trigger projection as an implicit damage amount.
 */
export function positiveDamageApplications(wave: ResolvedDamageWave): PendingEffect[] {
  return wave.applications
    .filter(
      (app) =>
        app.effect.kind === 'damage' &&
        wave.resolved.some((r) =>
          r.damage.some((d) => d.applicationId === app.id && BigInt(d.toHp.numerator) > 0n),
        ),
    )
    .map((app) => ({ ...app, parentEventId: app.id }));
}

export function reactionApplications(reactions: readonly ActivatedReaction[], step: number) {
  return reactions.flatMap((r) =>
    reactionPayload(r.actor, r.ability, r.display, r.display.context.activationId, step),
  );
}
