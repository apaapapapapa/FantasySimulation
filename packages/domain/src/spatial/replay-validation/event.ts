import { deferredReceipts } from './deferred.ts';
import type { StreamRecord } from '../stream.ts';
import type { ReplayCheckpoint } from '../replay.ts';
import type { ReplayContext } from './context.ts';
import {
  validateDeflection,
  validateDeflectionActivations,
  validateDeflectionContact,
  validateDeflectionPath,
} from './projectile.ts';
import { recordedStage } from './stage.ts';
import { validateForce } from './force.ts';
import { validateRevival } from './revival.ts';
import { validateRecovery } from './recovery.ts';
import { validateConceptEvent, validateDeferredDefinition } from './concepts.ts';
import { requireReplay, emittedId, phases, same } from './common.ts';
export function validateEvents(
  context: ReplayContext,
  prior: ReplayCheckpoint,
  record: Exclude<StreamRecord, { kind: 'initial' }>,
  entities: Set<string>,
) {
  const events = record.events,
    seen = new Set<number>();
  const receipts = deferredReceipts(prior.deferred, events);
  let previous = [-1, -1, -1];
  for (const [offset, e] of events.entries()) {
    validateConceptEvent(
      context,
      e,
      ('changes' in record
        ? record.changes.find((actor) => actor.id === e.actorId)?.clock
        : undefined) ?? prior.state?.actors.find((actor) => actor.id === e.actorId)?.clock,
    );
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
    if (e.actorId !== null)
      requireReplay(
        context.actors.some((a) => a.participant.actorId === e.actorId),
        'event actor reference',
      );
    if (e.targetId !== null) {
      const dependentIds = new Set([
        ...(prior.state?.dependents ?? []).map((dependent) => dependent.id),
        ...('dependents' in record
          ? [...(record.dependents?.spawn ?? []), ...(record.dependents?.update ?? [])].map(
              (dependent) => dependent.id,
            )
          : []),
      ]);
      requireReplay(
        context.actors.some((a) => a.participant.actorId === e.targetId) ||
          dependentIds.has(e.targetId),
        'event target reference',
      );
    }
    if (e.entityId !== null)
      requireReplay(
        entities.has(e.entityId) ||
          (e.kind === 'sensory-cue' && e.sensoryCue?.id === e.entityId) ||
          (e.kind === 'environmental-hologram' && e.environmentalHologram?.id === e.entityId),
        'event entity reference',
      );
    if (e.sensoryCue) {
      const cue = e.sensoryCue;
      requireReplay(
        e.kind === 'sensory-cue' &&
          e.entityId === cue.id &&
          e.actorId === cue.creatorId &&
          e.targetId === cue.observerId &&
          cue.creatorId !== cue.observerId &&
          cue.deliveredAt >= cue.emittedAt &&
          cue.discoveredAt <= cue.expiresAt &&
          e.step >= cue.emittedAt &&
          (cue.transition !== 'emitted' || e.step === cue.emittedAt) &&
          (cue.transition !== 'delivered' || e.step === cue.deliveredAt) &&
          (cue.transition !== 'discovered' || e.step === cue.discoveredAt) &&
          (cue.transition !== 'expired' || e.step === cue.expiresAt),
        'sensory cue transition',
      );
    } else requireReplay(e.kind !== 'sensory-cue', 'missing sensory cue event');
    if (e.environmentalHologram) {
      const hologram = e.environmentalHologram;
      requireReplay(
        e.kind === 'environmental-hologram' &&
          e.entityId === hologram.id &&
          e.actorId === hologram.creatorId &&
          e.targetId === hologram.observerId &&
          hologram.creatorId !== hologram.observerId &&
          hologram.observerIds.length === 1 &&
          hologram.observerIds[0] === hologram.observerId &&
          e.step >= hologram.activatedAt &&
          (hologram.transition === 'activated'
            ? hologram.state === 'active-unobserved'
            : hologram.transition === 'observed'
              ? hologram.state === 'observed'
              : hologram.state === 'invalidated') &&
          (hologram.transition !== 'activated' || e.step === hologram.activatedAt) &&
          (hologram.transition !== 'observed' || e.step === hologram.observedAt) &&
          (hologram.transition !== 'invalidated' || e.step === hologram.invalidatedAt) &&
          (hologram.transition !== 'expired' || e.step === hologram.expiresAt),
        'environmental hologram transition',
      );
    } else
      requireReplay(e.kind !== 'environmental-hologram', 'missing environmental hologram event');
    for (const receipt of e.timeStop?.captured ?? []) {
      validateDeferredDefinition(context, receipt);
      const capturedSource =
        ('changes' in record
          ? record.changes.find((actor) => actor.id === receipt.actorId)?.position
          : undefined) ??
        prior.state?.actors.find((actor) => actor.id === receipt.actorId)?.position;
      requireReplay(
        e.timeStop?.state === 'capture' &&
          receipt.controlId === e.timeStop.controlId &&
          receipt.capturedAt === e.step &&
          receipt.targetId === e.targetId &&
          receipt.actorId !== receipt.targetId,
        'capture receipt context',
      );
      if (receipt.effect.kind === 'environmental-hologram')
        requireReplay(
          !!receipt.sourcePosition &&
            !!capturedSource &&
            same(receipt.sourcePosition, capturedSource),
          'captured environmental hologram source geometry',
        );
      if (receipt.deflection) {
        const projectile = prior.state?.projectiles.find(
          (p) => p.id === receipt.sourceProjectileId,
        );
        requireReplay(
          !!projectile && same(projectile.deflection, receipt.deflection),
          'captured projectile provenance',
        );
      }
    }
    if (e.sourceActorId || e.sourceProjectileId) {
      const projectile = prior.state?.projectiles.find((p) => p.id === e.sourceProjectileId);
      const retained = receipts.find(
        (receipt) =>
          e.deferrals?.includes(receipt.id) && receipt.sourceProjectileId === e.sourceProjectileId,
      );
      const deflection =
        retained?.deflection ??
        projectile?.deflection ??
        events.find((p) => p.entityId === e.sourceProjectileId && p.kind === 'projectile-deflect')
          ?.projectileDeflection;
      requireReplay(
        !!deflection &&
          e.sourceActorId === deflection.originalOwnerId &&
          e.actorId === deflection.ownerId &&
          emittedId(deflection.eventId) < id &&
          !!e.sourceProjectileId &&
          (entities.has(e.sourceProjectileId) || !!retained),
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
      validateDeflectionContact(d, e, events);
      validateDeflectionActivations(d, events, e);
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
                (p) => p.id === e.entityId && p.reason === 'expired' && p.subtimeMicros === 1000000,
              ))),
        'deflection event transition',
      );
      validateDeflectionPath(d, e, record);
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
    for (const guard of e.damage?.guard?.responses ?? []) {
      const activation = events.find((candidate) => candidate.id === guard.activationId);
      const ability = context.actors
        .find((actor) => actor.participant.actorId === e.targetId)
        ?.abilities.find((candidate) => candidate.id === activation?.abilityId);
      requireReplay(
        activation?.kind === 'reaction' &&
          activation.ruleId === 'reaction.activated' &&
          activation.actorId === e.targetId &&
          ability?.definition.reaction?.response.kind === 'guard' &&
          ability.definition.reaction.response.retainedDamageBps === guard.retainedDamageBps,
        'guard activation provenance',
      );
    }
    if (e.stage) {
      const ability = context.actors
        .find((a) => a.participant.actorId === (e.sourceActorId ?? e.actorId))
        ?.abilities.find((a) => a.id === e.abilityId);
      recordedStage(ability, e.stage);
    }
    if (e.force) validateForce(context, e.force);
    if (e.teleport) {
      const actor = prior.state?.actors.find((a) => a.id === e.actorId);
      const delta = record.kind === 'boundary' && record.changes.find((a) => a.id === e.actorId);
      const ability = context.actors
        .find((a) => a.participant.actorId === e.actorId)
        ?.abilities.find((a) => a.id === e.abilityId);
      const spec = e.stage
        ? ability?.definition.stages?.[e.stage.stageIndex]?.relocation
        : ability?.definition.relocation;
      const definition = context.actors.find((a) => a.participant.actorId === e.actorId)?.character;
      const oldBody = actor?.posture?.body ?? definition?.body;
      const newBody = (delta && delta.posture?.body) || oldBody;
      const from =
        actor && oldBody && newBody
          ? {
              ...actor.position,
              y: actor.position.y + (newBody.heightMm - oldBody.heightMm) / 2000,
            }
          : null;
      const launch =
        prior.lastRecord?.kind === 'interval'
          ? prior.lastRecord.events.find((event) => event.id === e.parentEventId)
          : undefined;
      requireReplay(
        !!spec &&
          !!actor &&
          !!delta &&
          e.step > 0 &&
          e.parentEventId !== null &&
          same(e.teleport.from, from) &&
          launch?.kind === 'launch' &&
          launch.actorId === e.actorId &&
          launch.abilityId === e.abilityId &&
          launch.step === e.step - 1 &&
          same(e.teleport.to, delta.position ?? actor.position) &&
          events.filter((other) => other.teleport && other.actorId === e.actorId).length === 1,
        'teleport boundary displacement',
      );
      const a = e.teleport.from,
        b = e.teleport.to;
      requireReplay(
        Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) <= spec!.maxDistanceMm / 1000 + 1e-9,
        'teleport range',
      );
      const arena = context.manifest.revisions.find(
        (r) => r.kind === 'scenario' && r.id === context.manifest.scenario.id,
      );
      requireReplay(
        arena?.kind === 'scenario' &&
          !!newBody &&
          (['x', 'y', 'z'] as const).every((axis) => {
            const extent = (axis === 'y' ? newBody!.heightMm / 2 : newBody!.radiusMm) / 1000;
            return (
              b[axis] - extent >= arena.definition.bounds.min[axis] / 1000 &&
              b[axis] + extent <= arena.definition.bounds.max[axis] / 1000
            );
          }),
        'teleport arena containment',
      );
    }
    validateRecovery(context, e, events);
    validateRevival(context, e, events);
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
