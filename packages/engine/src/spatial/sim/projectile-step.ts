import { attackWorld } from '../rules/phasing.ts';
import type { AttackContact } from '../rules/attacks.ts';
import { opponentInDuel } from './duel.ts';
import type { ActorState, PreparedBattle } from '../state.ts';
import type { Budget, DisplayPath, ProjectileChanges } from '@fantasy/domain/spatial/execution';
import { type PendingEffect } from './combat-effects.ts';
import type { Journal } from '../rules/journal.ts';
import type { MovedActor } from '../world/movement.ts';
import { straight, clipTrace, type SpatialWorld } from '../world/physics.ts';
import { contactAttack } from '../rules/attack-contact.ts';
import type { HitLedger } from '../rules/hit-ledger.ts';
import {
  projectileCurve,
  displayProjectile,
  projectileEventSource,
  type ProjectileState,
} from '../rules/projectiles.ts';
import { impactEffects, removeImpact } from './projectile-impact.ts';
import { ProjectileContacts } from './projectile-deflection.ts';

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
  const impactContext = {
    // Resolution replaces actor motion; retain contact-time vision and facing.
    motions: actors.map((actor) => actor.body.motion),
    moved,
    world,
    battle,
    budget,
    journal,
    step,
    candidate,
    ledger,
    changes,
    ...(objectContact ? { objectContact } : {}),
  };
  const contacts = actors.some((a) =>
    a.body.motion.actor.abilities.some((b) => b.definition.reaction?.response.kind === 'deflect'),
  )
    ? new ProjectileContacts(impactContext, alive, paths)
    : undefined;
  for (const original of input) {
    let projectile = original;
    const age = projectile.clock?.age ?? step - projectile.launchStep;
    const shape = projectile.ability.definition.attack;
    if (shape.kind !== 'projectile' || age >= shape.lifetimeSteps)
      throw new Error('Invalid active projectile lifetime');
    const owner = actors.find(
      (a) => a.body.motion.actor.participant.actorId === projectile.ownerId,
    )!;
    if (owner.clock?.frozen) {
      const paused = {
        ...projectile,
        clock: { age, at: step + 1, paused: (projectile.clock?.paused ?? 0) + 1 },
      };
      alive.push(paused);
      paths.push({
        entityId: projectile.id,
        segments: straight(projectile.position, projectile.position),
      });
      const display = displayProjectile(paused);
      changes.update.push({
        id: projectile.id,
        position: { ...projectile.position },
        velocity: { ...projectile.velocity },
        clock: display.clock,
        endStep: display.endStep,
      });
      continue;
    }
    if (projectile.clock)
      projectile = { ...projectile, clock: { ...projectile.clock, age: age + 1, at: step + 1 } };
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
      elapsedSteps: age,
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
        ...projectileEventSource(projectile),
        parentEventId: projectile.cause,
        point: contact.point,
        ruleId: 'projectile.first-contact',
        reason: contact.kind,
      });
      const input = { projectile, contact, curve, impact, enemy };
      if (
        contacts &&
        contact.kind === 'body' &&
        !actors.find(
          (actor) =>
            actor.body.motion.actor.participant.actorId === enemy.state.actor.participant.actorId,
        )!.clock?.frozen
      )
        contacts.add(input);
      else {
        effects.push(...impactEffects(input, impactContext, true, !!projectile.deflection));
        removeImpact(input, impactContext);
      }
    } else if (age + 1 === shape.lifetimeSteps) {
      changes.remove.push({ id: projectile.id, subtimeMicros: 1_000_000, reason: 'expired' });
      journal.emit({
        kind: 'projectile-remove',
        step,
        phase: 'contact',
        subtimeMicros: 1_000_000,
        ...projectileEventSource(projectile),
        parentEventId: projectile.cause,
        ruleId: 'projectile.expired',
        point: curve.next.position,
      });
    } else {
      alive.push(curve.next);
      changes.update.push({
        id: projectile.id,
        position: { ...curve.next.position },
        velocity: { ...curve.next.velocity },
        ...(projectile.clock
          ? {
              clock: displayProjectile(curve.next).clock,
              endStep: displayProjectile(curve.next).endStep,
            }
          : {}),
      });
    }
  }
  return { alive, paths, effects, changes, contacts };
}
