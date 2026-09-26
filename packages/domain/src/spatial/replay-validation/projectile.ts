import type { ProjectileDisplay, StreamRecord } from '../stream.ts';
import type { BattleEvent, ProjectileDeflection } from '../records.ts';
import { canonicalJson } from '../canonical.ts';
import type { ReplayContext } from './context.ts';
import { recordedStage } from './stage.ts';
import { requireReplay, emittedId } from './common.ts';
export function validateDeflection(context: ReplayContext, d: ProjectileDeflection, step: number) {
  const owner = context.actors.find((a) => a.participant.actorId === d.ownerId);
  requireReplay(
    !!owner &&
      d.originalOwnerId !== d.ownerId &&
      context.actors.some((a) => a.participant.actorId === d.originalOwnerId) &&
      d.step <= step &&
      d.step > 0,
    'deflection ownership/time',
  );
  requireReplay(
    (d.basis === 'observed-position') === !!d.observedPosition &&
      Math.abs(
        Math.hypot(d.velocity.x, d.velocity.y, d.velocity.z) -
          Math.hypot(d.incomingVelocity.x, d.incomingVelocity.y, d.incomingVelocity.z),
      ) < 1e-6,
    'deflection basis/speed',
  );
  const delta = d.observedPosition
    ? {
        x: d.observedPosition.x - d.position.x,
        y: d.observedPosition.y - d.position.y,
        z: d.observedPosition.z - d.position.z,
      }
    : null;
  const direction =
    delta && Math.hypot(delta.x, delta.y, delta.z) > 1e-12
      ? delta
      : { x: -d.incomingVelocity.x, y: -d.incomingVelocity.y, z: -d.incomingVelocity.z };
  const size = Math.hypot(direction.x, direction.y, direction.z);
  const speed = Math.hypot(d.incomingVelocity.x, d.incomingVelocity.y, d.incomingVelocity.z);
  requireReplay(
    (['x', 'y', 'z'] as const).every(
      (axis) =>
        Math.abs(d.velocity[axis] - (size > 0 ? (direction[axis] * speed) / size : 0)) < 1e-6,
    ),
    'deflection direction',
  );
  requireReplay(
    new Set(d.activations.map((a) => a.abilityId)).size === d.activations.length &&
      new Set(d.activations.map((a) => a.context.activationId)).size === d.activations.length,
    'deflection activations',
  );
  let product = 10000n;
  for (const activation of d.activations) {
    const ability = owner!.abilities.find((a) => a.id === activation.abilityId);
    const response = ability?.definition.reaction?.response;
    requireReplay(
      response?.kind === 'deflect' &&
        activation.context.point === 'before-hit' &&
        emittedId(activation.context.activationId) < emittedId(d.eventId),
      'deflection response reference',
    );
    product *= BigInt(response!.kind === 'deflect' ? (response!.powerBps ?? 10000) : 0);
  }
  product /= 10000n ** BigInt(d.activations.length);
  requireReplay(d.powerBps === Number(product > 30000n ? 30000n : product), 'deflection power');
}
export function validateDeflectionActivations(
  d: ProjectileDeflection,
  events: readonly BattleEvent[],
  causes: readonly string[],
) {
  for (const activation of d.activations) {
    const event = events.find((e) => e.id === activation.context.activationId);
    requireReplay(
      event?.kind === 'reaction' &&
        event.ruleId === 'reaction.activated' &&
        event.actorId === d.ownerId &&
        event.abilityId === activation.abilityId &&
        event.step === d.step &&
        canonicalJson(event.reaction) === canonicalJson(activation.context) &&
        causes.includes(event.id),
      'deflection activation event',
    );
  }
}
export function validateProjectile(
  context: ReplayContext,
  p: ProjectileDisplay,
  step: number,
  nextEvent: number,
) {
  const owner = context.actors.find(
    (a) => a.participant.actorId === (p.deflection?.originalOwnerId ?? p.ownerId),
  );
  const ability = owner?.abilities.find((a) => a.id === p.abilityId);
  const attack = p.stage ? recordedStage(ability, p.stage).attack : ability?.definition.attack;
  requireReplay(!!p.stage === !!ability?.definition.stages, 'projectile stage display');
  requireReplay(
    p.id.startsWith('projectile.') &&
      attack?.kind === 'projectile' &&
      p.radiusMm === attack.radiusMm &&
      p.endStep === p.launchStep + attack.lifetimeSteps &&
      p.launchStep <= step &&
      p.endStep > step,
    'projectile reference/time',
  );
  if (p.deflection) {
    validateDeflection(context, p.deflection, step);
    requireReplay(
      p.ownerId === p.deflection.ownerId &&
        p.deflection.step > p.launchStep &&
        emittedId(p.deflection.eventId) < nextEvent,
      'projectile deflection provenance',
    );
  }
}

export function validateProjectileUpdate(
  before: ProjectileDisplay,
  update: Extract<StreamRecord, { kind: 'interval' }>['projectiles']['update'][number],
  record: Extract<StreamRecord, { kind: 'interval' }>,
) {
  if (update.deflection) {
    const event = record.events.find((e) => e.id === update.deflection!.eventId);
    requireReplay(
      !before.deflection &&
        update.ownerId === update.deflection.ownerId &&
        before.ownerId === update.deflection.originalOwnerId &&
        update.deflection.step === record.toStep &&
        event?.entityId === update.id &&
        canonicalJson(event.projectileDeflection) === canonicalJson(update.deflection) &&
        canonicalJson(update.position) === canonicalJson(update.deflection.position) &&
        canonicalJson(update.velocity) === canonicalJson(update.deflection.velocity),
      'projectile ownership transition',
    );
  } else
    requireReplay(
      update.ownerId === undefined || update.ownerId === before.ownerId,
      'projectile owner without deflection',
    );
}
