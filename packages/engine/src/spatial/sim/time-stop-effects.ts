import { canonicalJson, EffectSchema } from '@fantasy/domain/spatial/execution';
import { resolveEffects } from '../rules/effects.ts';
import { domainSnapshotStep, frozen } from '../rules/subject-clocks.ts';
import { SpatialBudgetError } from '../world/physics.ts';
import type { PendingEffect, EffectContext } from './combat-effects.ts';
import { type StepTransaction } from './step-transaction.ts';
import { appendStopDescriptors, captureDescriptor } from './time-stop-state.ts';
import { releaseStop, stopEvent } from './time-stop-control.ts';
import { evadedApplications } from './contact-evasion.ts';
import { canObserveActor } from '../world/visibility.ts';

export function stopEffectHooks(tx: StepTransaction, context: EffectContext) {
  if (!tx.next.stop) return {};
  const statusSteps = new Map<string, number>();
  return {
    statusSteps,
    capture: (effects: PendingEffect[]) => {
      const stop = tx.next.stop!,
        active = stop.active;
      if (!active) return effects;
      const captured = effects.filter(
        (effect) =>
          effect.actorId &&
          effect.actorId !== effect.targetId &&
          effect.targetId === active.targetId,
      );
      if (!captured.length) return effects;
      const descriptors = captured.map((effect, index) => {
        const projectile =
          effect.sourceProjectileId &&
          tx.previous.projectiles.find((p) => p.id === effect.sourceProjectileId);
        const deferral = {
          id: `deferred.${stop.operations + index}`,
          controlId: active.id,
          capturedAt: context.activationStep,
          actorId: effect.actorId!,
          targetId: effect.targetId,
          abilityId: effect.abilityId!,
          effect: EffectSchema.parse(effect.effect),
          ...(effect.sourceActorId
            ? {
                sourceActorId: effect.sourceActorId,
                sourceProjectileId: effect.sourceProjectileId!,
                ...(projectile && projectile.deflection
                  ? { deflection: structuredClone(projectile.deflection) }
                  : {}),
              }
            : {}),
        };
        const source = tx.next.actors.find(
          (actor) => actor.body.motion.actor.participant.actorId === effect.actorId,
        )!;
        const target = tx.next.actors.find(
          (actor) => actor.body.motion.actor.participant.actorId === effect.targetId,
        )!;
        return captureDescriptor({
          ...effect,
          deferral,
          capturedVisible: canObserveActor(
            context.world,
            effect.observation?.self ?? source.body.motion,
            effect.observation?.target ?? target.body.motion,
          ),
        });
      });
      const contacts = new Set(
        captured.map((effect) =>
          canonicalJson([effect.actorId, effect.targetId, effect.abilityId, effect.parentEventId]),
        ),
      ).size;
      const appended = appendStopDescriptors(stop, descriptors);
      // Preflight the whole simultaneous set before changing counts or emitting captures.
      for (const [resource, observed, limit] of [
        ['stop-contacts', stop.contacts + contacts, 256],
        ['stop-operations', stop.operations + descriptors.length, 4096],
        ['stop-bytes', appended.bytes, Math.min(65536, tx.context.budget.maxFrameBytes)],
      ] as const)
        if (observed > limit)
          throw new SpatialBudgetError(resource, undefined, {
            observed,
            limit,
            cause: captured[0]!.parentEventId ?? active.cause,
          });
      stop.contacts += contacts;
      stop.operations += descriptors.length;
      Object.assign(stop, appended);
      const event = stopEvent(
        tx,
        active,
        'capture',
        context.activationStep,
        `${contacts} contacts; ${descriptors.length} fixed effect descriptors`,
        context.phase === 'boundary' ? 'boundary' : 'resolution',
      );
      event.timeStop!.captured = descriptors.map((descriptor) => descriptor.deferral!);
      return effects.filter((effect) => !captured.includes(effect));
    },
    beforeCommit: (effects: PendingEffect[]) => {
      if (!tx.next.stop?.active) return effects;
      // Pure probe: no IDs, costs, RNG, HP, status or protection-use mutation.
      tx.context.work.candidate();
      const omitted = evadedApplications(tx.next.actors, effects, context.step);
      const planned = resolveEffects(
        tx.next.actors.map((actor) => ({
          actor: actor.body.motion.actor,
          resources: actor.vitals.resources,
          statuses: actor.statuses,
          ...(frozen(actor) ? { statusStep: domainSnapshotStep(actor, context.step) } : {}),
          ...(actor.vitals.immortalityUsed !== undefined
            ? { immortalityUsed: actor.vitals.immortalityUsed }
            : {}),
        })),
        effects
          .filter((effect) => !omitted.has(effect))
          .map((effect, i) => ({ ...effect, id: `probe.${i}` })),
        context.battle.statuses,
        context.step,
        context.activationStep,
        context.budget,
        true,
        true,
      );
      if (!planned.some((result) => result.resources.hp === 0)) return effects;
      const targetId = tx.next.stop.active.targetId;
      const released = releaseStop(
        tx,
        context.activationStep,
        'prospective-defeat; opening wave recomputed once',
        context.phase === 'boundary' ? 'boundary' : 'resolution',
      );
      statusSteps.set(targetId, context.activationStep);
      return [...effects, ...released];
    },
  };
}
