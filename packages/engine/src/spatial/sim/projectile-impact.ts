import type { ActorState, PreparedBattle } from '../state.ts';
import type { Budget, ProjectileChanges } from '@fantasy/domain/spatial/execution';
import { contactObservation, type PendingEffect } from './combat-effects.ts';
import type { Journal } from '../rules/journal.ts';
import type { MovedActor } from '../world/movement.ts';
import { at, type SpatialWorld } from '../world/physics.ts';
import { copyDamageSnapshot } from '../rules/status-damage.ts';
import type { contactAttack } from '../rules/attack-contact.ts';
import type { HitLedger } from '../rules/hit-ledger.ts';
import {
  explosionCoverage,
  projectileEventSource,
  type projectileCurve,
  type ProjectileState,
} from '../rules/projectiles.ts';
import { sub, unit } from '../math.ts';

export type ProjectileImpact = {
  projectile: ProjectileState;
  contact: NonNullable<ReturnType<typeof contactAttack>['contact']>;
  curve: ReturnType<typeof projectileCurve>;
  impact: { id: string };
  bodyAdmission?: ReturnType<HitLedger['contact']> | null;
  owner: ActorState;
  enemy: MovedActor;
};
export type ProjectileImpactContext = {
  actors: readonly ActorState[];
  moved: readonly MovedActor[];
  world: SpatialWorld;
  battle: PreparedBattle;
  budget: Budget;
  journal: Journal;
  step: number;
  candidate: () => void;
  ledger: HitLedger;
  changes: ProjectileChanges;
};
/** Preview and commitment share geometry and payloads; only commitment writes ledger/events. */
export function impactEffects(
  input: ProjectileImpact,
  context: ProjectileImpactContext,
  emit = true,
  tracked = false,
) {
  const { projectile, contact, curve, impact, owner, enemy } = input;
  const { actors, moved, world, journal, step, candidate } = context;
  const ledger = emit ? context.ledger : context.ledger.clone();
  const shape = projectile.ability.definition.attack;
  if (shape.kind !== 'projectile') throw new Error('Invalid projectile impact');
  const subtimeMicros = Math.round(contact.time * 1_000_000);
  const effects: PendingEffect[] = [];
  for (const target of moved) {
    const targetId = target.state.actor.participant.actorId;
    let scaleBps = 0;
    if (shape.explosionRadiusMm > 0) {
      candidate();
      scaleBps = explosionCoverage(
        world,
        contact.center,
        shape.explosionRadiusMm / 1000,
        target.state,
        at(target.trace, contact.time),
      );
    } else if (contact.kind === 'body' && targetId === enemy.state.actor.participant.actorId)
      scaleBps = 10000;
    if (scaleBps === 0) continue;
    const admission =
      input.bodyAdmission !== undefined && targetId === enemy.state.actor.participant.actorId
        ? input.bodyAdmission
        : projectile.stage
          ? ledger.contact(projectile.stage, projectile.hit, targetId, step)
          : null;
    const hit = emit
      ? journal.emit({
          kind: admission?.accepted === false ? 'diagnostic' : 'hit',
          step,
          phase: 'contact',
          subtimeMicros,
          actorId: projectile.ownerId,
          ...(projectile.deflection
            ? {
                sourceActorId: projectile.deflection.originalOwnerId,
                sourceProjectileId: projectile.id,
              }
            : {}),
          targetId,
          entityId: projectile.id,
          abilityId: projectile.ability.id,
          parentEventId: impact.id,
          ruleId: shape.explosionRadiusMm > 0 ? 'explosion.coverage' : 'projectile.hit',
          point: shape.explosionRadiusMm > 0 ? contact.center : contact.point,
          amount: scaleBps,
          reason: admission?.reason ?? 'coverage-bps',
          ...(projectile.stage ? { stage: projectile.stage } : {}),
        })
      : { id: impact.id };
    if (admission?.accepted === false) continue;
    const incoming = curve.trace.find((segment) => contact.time <= segment.to)!;
    for (const effect of projectile.ability.definition.effects)
      effects.push({
        actorId: projectile.ownerId,
        targetId,
        effect,
        ...copyDamageSnapshot(projectile),
        parentEventId: hit.id,
        abilityId: projectile.ability.id,
        ...(projectile.stage ? { stage: projectile.stage } : {}),
        scaleBps,
        ...(tracked
          ? {
              sourceAbility: projectile.ability,
              projectileContact: {
                id: projectile.id,
                direct: false,
                reflected: !!projectile.deflection,
              },
            }
          : {}),
        ...(projectile.deflection
          ? {
              sourceActorId: projectile.deflection.originalOwnerId,
              sourceProjectileId: projectile.id,
              powerBps: projectile.deflection.powerBps,
              ancestry: projectile.deflection.activations.reduce((a, b) =>
                a.context.depth >= b.context.depth ? a : b,
              ).context,
            }
          : {}),
        incomingDirection: unit(
          shape.explosionRadiusMm > 0
            ? sub(contact.center, at(target.trace, contact.time))
            : sub(incoming.start, incoming.end),
        ),
        observation: contactObservation(
          moved,
          owner.body.motion,
          actors.find((a) => a.body.motion.actor.participant.actorId === targetId)!.body.motion,
          contact.time,
        ),
      });
  }
  return effects;
}
export function removeImpact(input: ProjectileImpact, context: ProjectileImpactContext) {
  const { projectile, contact, impact } = input;
  const { changes, journal, step } = context;
  const subtimeMicros = Math.round(contact.time * 1_000_000);
  changes.remove.push({ id: projectile.id, subtimeMicros, reason: contact.kind });
  journal.emit({
    kind: 'projectile-remove',
    step,
    phase: 'contact',
    subtimeMicros,
    ...projectileEventSource(projectile),
    parentEventId: impact.id,
    abilityId: projectile.ability.id,
    ruleId: 'projectile.remove',
    point: contact.center,
    reason: contact.kind,
  });
}
