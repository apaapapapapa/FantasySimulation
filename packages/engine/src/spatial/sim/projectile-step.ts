import { attackWorld } from '../rules/phasing.ts';
import type { AttackContact } from '../rules/attacks.ts';
import { opponentInDuel } from './duel.ts';
import type { ActorState, PreparedBattle } from '../state.ts';
import type { Budget, DisplayPath, ProjectileChanges } from '@fantasy/domain/spatial/execution';
import { contactObservation, type PendingEffect } from './combat-effects.ts';
import type { Journal } from '../rules/journal.ts';
import type { MovedActor } from '../world/movement.ts';
import { at, clipTrace, type SpatialWorld } from '../world/physics.ts';
import { copyDamageSnapshot } from '../rules/status-damage.ts';
import { contactAttack } from '../rules/attack-contact.ts';
import type { HitLedger } from '../rules/hit-ledger.ts';
import { explosionCoverage, projectileCurve, type ProjectileState } from '../rules/projectiles.ts';
import { sub, unit } from '../math.ts';

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
  ledger: HitLedger,
  objectContact?: (projectile: ProjectileState, contact: AttackContact, cause: string) => void,
) {
  const alive: ProjectileState[] = [],
    paths: DisplayPath[] = [],
    effects: PendingEffect[] = [];
  const changes: ProjectileChanges = { spawn: [], update: [], remove: [] };
  for (const projectile of input) {
    const shape = projectile.ability.definition.attack;
    if (shape.kind !== 'projectile' || projectile.launchStep + shape.lifetimeSteps <= step)
      throw new Error('Invalid active projectile lifetime');
    const owner = actors.find(
      (a) => a.body.motion.actor.participant.actorId === projectile.ownerId,
    )!;
    const enemy = opponentInDuel(
      moved,
      projectile.ownerId,
      (a) => a.state.actor.participant.actorId,
    );
    const curve = projectileCurve(projectile, owner.mind.memory, battle.rules, budget);
    candidate();
    const { contact } = contactAttack(shape, {
      world: attackWorld(world, projectile),
      source: owner.body.motion,
      target: enemy.state,
      trace: curve.trace,
      targetTrace: enemy.trace,
      direction: projectile.velocity,
      offset: { x: 0, y: 0, z: 0 },
      rangeMm: projectile.ability.definition.rangeMm,
      elapsedSteps: step - projectile.launchStep,
      stageDuration: undefined,
      staged: !!projectile.stage,
      rules: battle.rules,
      budget,
    });
    paths.push({
      entityId: projectile.id,
      segments: contact ? clipTrace(curve.trace, contact.time) : curve.trace,
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
      objectContact?.(projectile, contact, impact.id);
      for (const target of moved) {
        const targetId = target.state.actor.participant.actorId;
        let scaleBps = 0;
        if (shape.explosionRadiusMm > 0) {
          candidate();
          scaleBps = explosionCoverage(
            attackWorld(world, projectile),
            contact.center,
            shape.explosionRadiusMm / 1000,
            target.state,
            at(target.trace, contact.time),
            contact.obstacleIds,
          );
        } else if (contact.kind === 'body' && targetId === enemy.state.actor.participant.actorId)
          scaleBps = 10000;
        if (scaleBps === 0) continue;
        const admission = projectile.stage
          ? ledger.contact(projectile.stage, projectile.hit, targetId, step)
          : null;
        const hit = journal.emit({
          kind: admission?.accepted === false ? 'diagnostic' : 'hit',
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
          reason: admission?.reason ?? 'coverage-bps',
          ...(projectile.stage ? { stage: projectile.stage } : {}),
        });
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
