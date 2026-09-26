import type { StreamRecord } from '../stream.ts';
import type { ReplayCheckpoint } from '../replay.ts';
import type { ReplayContext } from './context.ts';
import { validateDeflection } from './projectile.ts';
import { recordedStage } from './stage.ts';
import { validateForce } from './force.ts';
import { requireReplay, emittedId, phases } from './common.ts';
export function validateEvents(
  context: ReplayContext,
  prior: ReplayCheckpoint,
  record: Exclude<StreamRecord, { kind: 'initial' }>,
  entities: Set<string>,
) {
  const events = record.events,
    seen = new Set<number>();
  let previous = [-1, -1, -1];
  for (const [offset, e] of events.entries()) {
    const id = emittedId(e.id);
    requireReplay(
      e.sequence === prior.nextEvent + offset &&
        id >= prior.nextEvent &&
        id < prior.nextEvent + events.length &&
        !seen.has(id),
      'event sequence/identity',
    );
    seen.add(id);
    // IDs track emission/causality; sequence tracks the phase-sorted display order.
    for (const cause of [...e.causes, ...(e.parentEventId ? [e.parentEventId] : [])])
      requireReplay(emittedId(cause) < id, 'event causal reference');
    const maxStep = record.kind === 'interval' ? record.toStep : record.step;
    requireReplay(e.step >= prior.step && e.step <= maxStep, 'event step');
    if (record.kind === 'boundary')
      requireReplay(e.phase === 'boundary' || e.phase === 'resolution', 'boundary event phase');
    if (record.kind === 'terminal')
      requireReplay(e.kind === 'terminal' && e.phase === 'terminal', 'terminal event');
    else requireReplay(e.phase !== 'terminal' && e.kind !== 'terminal', 'early terminal');
    const order = [e.step, phases[e.phase], e.subtimeMicros];
    requireReplay(
      order[0]! > previous[0]! ||
        (order[0] === previous[0] &&
          (order[1]! > previous[1]! || (order[1] === previous[1] && order[2]! >= previous[2]!))),
      'event order',
    );
    previous = order;
    for (const id of [e.actorId, e.targetId])
      if (id !== null)
        requireReplay(
          context.actors.some((a) => a.participant.actorId === id),
          'event actor reference',
        );
    if (e.entityId !== null) requireReplay(entities.has(e.entityId), 'event entity reference');
    if (e.sourceActorId || e.sourceProjectileId) {
      const projectile = prior.state?.projectiles.find((p) => p.id === e.sourceProjectileId);
      const deflection =
        projectile?.deflection ??
        events.find((p) => p.entityId === e.sourceProjectileId && p.kind === 'projectile-deflect')
          ?.projectileDeflection;
      requireReplay(
        !!deflection &&
          e.sourceActorId === deflection.originalOwnerId &&
          e.actorId === deflection.ownerId &&
          emittedId(deflection.eventId) < id &&
          !!e.sourceProjectileId &&
          entities.has(e.sourceProjectileId),
        'event projectile provenance',
      );
    }
    if (e.projectileDeflection) {
      const d = e.projectileDeflection;
      const before =
        prior.state?.projectiles.find((p) => p.id === e.entityId) ??
        (record.kind === 'interval'
          ? record.projectiles.spawn.find((p) => p.id === e.entityId)
          : undefined);
      validateDeflection(context, d, maxStep);
      requireReplay(
        e.kind === 'projectile-deflect' &&
          d.eventId === e.id &&
          d.step === e.step &&
          d.ownerId === e.actorId &&
          d.originalOwnerId === e.targetId &&
          !!e.entityId &&
          !!before &&
          !before.deflection &&
          before.ownerId === d.originalOwnerId &&
          d.step > before.launchStep,
        'deflection event identity',
      );
      requireReplay(
        record.kind === 'interval' &&
          (record.projectiles.update.some(
            (p) => p.id === e.entityId && p.deflection?.eventId === e.id,
          ) ||
            (before!.endStep === record.toStep &&
              record.projectiles.remove.some(
                (p) => p.id === e.entityId && p.reason === 'expired',
              ))),
        'deflection event transition',
      );
    } else requireReplay(e.kind !== 'projectile-deflect', 'missing deflection event');
    if (e.abilityId !== null)
      requireReplay(
        e.actorId === null
          ? context.manifest.revisions.some((r) => r.kind === 'ability' && r.id === e.abilityId)
          : context.actors
              .find((a) => a.participant.actorId === (e.sourceActorId ?? e.actorId))!
              .abilities.some((a) => a.id === e.abilityId),
        'event ability reference',
      );
    if (e.stage) {
      const ability = context.actors
        .find((a) => a.participant.actorId === (e.sourceActorId ?? e.actorId))
        ?.abilities.find((a) => a.id === e.abilityId);
      recordedStage(ability, e.stage);
    }
    if (e.force) validateForce(context, e.force);
    if (e.reaction) {
      const ability = context.actors
        .find((a) => a.participant.actorId === (e.sourceActorId ?? e.actorId))
        ?.abilities.find((a) => a.id === e.abilityId);
      requireReplay(
        !!ability?.definition.reaction &&
          ability.definition.trigger === e.reaction.point &&
          (e.ruleId === 'reaction.activated'
            ? e.reaction.activationId === e.id
            : emittedId(e.reaction.activationId) < id),
        'reaction event reference',
      );
    }
  }
  requireReplay(prior.nextEvent + events.length <= 1_000_001, 'event limit');
}
