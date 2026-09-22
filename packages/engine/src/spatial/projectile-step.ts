import type { Budget, DisplayPath, ProjectileChanges } from '@fantasy/domain/spatial';
import type { ActorState } from './combat-state.ts';
import type { PendingEffect } from './combat-effects.ts';
import type { Journal } from './journal.ts';
import type { MovedActor } from './movement.ts';
import type { PreparedBattle } from './prepare.ts';
import { at, type SpatialWorld } from './physics.ts';
import { traceAttack } from './attacks.ts';
import {
  clipProjectile,
  explosionCoverage,
  projectileCurve,
  type ProjectileState,
} from './projectiles.ts';

/** Every contact uses the same committed movement traces; damage is returned for simultaneous resolution. */
export function stepProjectiles(
  input: readonly ProjectileState[],
  actors: readonly ActorState[],
  moved: readonly MovedActor[],
  world: SpatialWorld,
  battle: PreparedBattle,
  budget: Budget,
  journal: Journal,
  step: number,
  candidate: () => void,
) {
  const alive: ProjectileState[] = [],
    paths: DisplayPath[] = [],
    effects: PendingEffect[] = [];
  const changes: ProjectileChanges = { spawn: [], update: [], remove: [] };
  for (const projectile of input) {
    const shape = projectile.ability.definition.attack;
    if (shape.kind !== 'projectile' || projectile.launchStep + shape.lifetimeSteps <= step)
      throw new Error('Invalid active projectile lifetime');
    const owner = actors.find((a) => a.motion.actor.participant.actorId === projectile.ownerId)!;
    const enemy = moved.find((a) => a.state.actor.participant.actorId !== projectile.ownerId)!;
    const curve = projectileCurve(projectile, owner.memory, battle.rules, budget);
    candidate();
    const contact = traceAttack(
      world,
      curve.trace,
      shape.radiusMm / 1000,
      enemy.state,
      enemy.trace,
    );
    paths.push({
      entityId: projectile.id,
      segments: contact ? clipProjectile(curve.trace, contact.time) : curve.trace,
    });
    if (contact) {
      const subtimeMicros = Math.round(contact.time * 1_000_000);
      const impact = journal.emit({
        kind: 'diagnostic',
        step,
        phase: 'contact',
        subtimeMicros,
        entityId: projectile.id,
        actorId: projectile.ownerId,
        parentEventId: projectile.cause,
        abilityId: projectile.ability.id,
        point: contact.point,
        ruleId: 'projectile.first-contact',
        reason: contact.kind,
      });
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
        const hit = journal.emit({
          kind: 'hit',
          step,
          phase: 'contact',
          subtimeMicros,
          actorId: projectile.ownerId,
          targetId,
          entityId: projectile.id,
          abilityId: projectile.ability.id,
          parentEventId: impact.id,
          ruleId: shape.explosionRadiusMm > 0 ? 'explosion.coverage' : 'projectile.hit',
          point: shape.explosionRadiusMm > 0 ? contact.center : contact.point,
          amount: scaleBps,
          reason: 'coverage-bps',
        });
        for (const effect of projectile.ability.definition.effects)
          effects.push({
            actorId: projectile.ownerId,
            targetId,
            effect,
            attack: projectile.attack,
            parentEventId: hit.id,
            abilityId: projectile.ability.id,
            scaleBps,
          });
      }
      changes.remove.push({ id: projectile.id, subtimeMicros, reason: contact.kind });
      journal.emit({
        kind: 'projectile-remove',
        step,
        phase: 'contact',
        subtimeMicros,
        entityId: projectile.id,
        actorId: projectile.ownerId,
        parentEventId: impact.id,
        abilityId: projectile.ability.id,
        ruleId: 'projectile.remove',
        point: contact.center,
        reason: contact.kind,
      });
    } else if (step + 1 === projectile.launchStep + shape.lifetimeSteps) {
      changes.remove.push({ id: projectile.id, subtimeMicros: 1_000_000, reason: 'expired' });
      journal.emit({
        kind: 'projectile-remove',
        step,
        phase: 'contact',
        subtimeMicros: 1_000_000,
        entityId: projectile.id,
        actorId: projectile.ownerId,
        parentEventId: projectile.cause,
        abilityId: projectile.ability.id,
        ruleId: 'projectile.expired',
        point: curve.next.position,
      });
    } else {
      alive.push(curve.next);
      changes.update.push({
        id: projectile.id,
        position: { ...curve.next.position },
        velocity: { ...curve.next.velocity },
      });
    }
  }
  return { alive, paths, effects, changes };
}
