import { effectiveStatuses } from '@fantasy/domain/spatial/execution';
import type { ActorState, PendingEffect } from '../state.ts';
import { abilityCategories } from '../rules/categories.ts';
import type { EffectContext } from './effect-context.ts';

/** Authored contact evasion is a finite status reducer, after paid reactions and before effects.
 * It never evades self/periodic/environment effects. Any matching component cancels its contact. */
function evasionGroups(
  actors: ActorState[],
  effects: PendingEffect[],
  step: number,
  statusSteps?: ReadonlyMap<string, number>,
) {
  if (!actors.some((actor) => actor.statuses.some((status) => status.revision.definition.evasion)))
    return [];
  const groups = new Map<string, PendingEffect[]>();
  for (const effect of effects) {
    const key = JSON.stringify([
      effect.actorId,
      effect.targetId,
      effect.abilityId,
      effect.parentEventId,
    ]);
    const group = groups.get(key) ?? [];
    group.push(effect);
    groups.set(key, group);
  }
  const groupsEvaded: {
    contact: PendingEffect[];
    evaders: ActorState['statuses'];
    target: ActorState;
  }[] = [];
  for (const contact of groups.values()) {
    const first = contact[0]!;
    if (!first.actorId || first.actorId === first.targetId || !first.abilityId) continue;
    const target = actors.find(
      (actor) => actor.body.motion.actor.participant.actorId === first.targetId,
    )!;
    const source =
      first.sourceAbility ??
      actors
        .find(
          (actor) =>
            actor.body.motion.actor.participant.actorId === (first.sourceActorId ?? first.actorId),
        )
        ?.body.motion.actor.abilities.find((ability) => ability.id === first.abilityId);
    if (!source) continue;
    const evaders = effectiveStatuses(
      target.statuses,
      statusSteps?.get(first.targetId) ?? step,
    ).filter((status) => {
      const spec = status.revision.definition.evasion;
      return (
        spec &&
        (!spec.categories ||
          spec.categories.some((category) =>
            abilityCategories(source.definition).includes(category),
          )) &&
        (!spec.elements ||
          contact.some(
            (application) =>
              application.effect.kind === 'damage' &&
              spec.elements!.includes(application.effect.element),
          ))
      );
    });
    if (!evaders.length) continue;
    groupsEvaded.push({ contact, evaders, target });
  }
  return groupsEvaded;
}
export function evadedApplications(
  actors: ActorState[],
  effects: PendingEffect[],
  step: number,
  statusSteps?: ReadonlyMap<string, number>,
) {
  return new Set(
    evasionGroups(actors, effects, step, statusSteps).flatMap((group) => group.contact),
  );
}
export function evadeContacts(
  actors: ActorState[],
  effects: PendingEffect[],
  context: EffectContext,
) {
  const cancelled = new Set<PendingEffect>();
  for (const { contact, evaders, target } of evasionGroups(
    actors,
    effects,
    context.step,
    context.statusSteps,
  )) {
    const first = contact[0]!;
    contact.forEach((effect) => cancelled.add(effect));
    target.vitals.conceptCue = { kind: 'absolute-evasion', at: context.activationStep };
    context.journal.emit({
      ...(contact.some((effect) => effect.deferral)
        ? { deferrals: contact.flatMap((effect) => (effect.deferral ? [effect.deferral.id] : [])) }
        : {}),
      kind: 'evasion',
      step: context.activationStep,
      phase: context.phase,
      actorId: first.targetId,
      targetId: first.actorId,
      parentEventId: first.parentEventId,
      ruleId: 'concept.contact-evasion',
      reason:
        'selected whole contact cancelled; admitted hit ledger retained; no-error aiming does not pierce',
      evasion: {
        statuses: evaders.map((status) => ({
          id: status.revision.id,
          revision: status.revision.revision,
          contentHash: status.revision.contentHash,
        })),
      },
    });
  }
  return effects.filter((effect) => !cancelled.has(effect));
}
