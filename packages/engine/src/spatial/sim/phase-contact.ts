import type { MeleeState } from '../state.ts';
import { meleeTrace, traceAttack, type AttackContact } from '../attacks.ts';
import { contactObservation } from '../combat-effects.ts';
import { moveActors } from '../movement.ts';
import { reserveMotion } from '../motion-resources.ts';
import { clipTrace } from '../physics.ts';
import { isDodgeDecision } from '../policy.ts';
import { stepProjectiles } from '../projectile-step.ts';
import { copyDamageSnapshot } from '../status-damage.ts';
import { settleForcedInterval } from '../forces.ts';
import { sweepBlade } from '../blades.ts';
import { type StepTransaction, actorId } from './step-transaction.ts';
export function contactPhase(tx: StepTransaction) {
  const { battle, budget, world, work } = tx.context;
  const { step, journal, effects, resourceBudgets, forcePlans, aiBoundary } = tx;
  const next = tx.next.actors,
    attacks = tx.next.melees,
    bullets = tx.next.projectiles,
    nextLedger = tx.next.ledger;
  const motionPlans = next.map((actor) =>
    reserveMotion(
      actor,
      resourceBudgets.get(actorId(actor))!,
      step,
      aiBoundary && isDodgeDecision(actor.mind.decision),
    ),
  );
  for (const [index, actor] of next.entries()) actor.body.intent = motionPlans[index]!.intent;
  const moved = moveActors(
    world,
    next.map((a) => a.body.motion),
    new Map(next.map((a) => [actorId(a), a.body.intent])),
    battle.rules,
    budget.maxMoveSegments,
  );
  for (const [index, movement] of moved.entries()) motionPlans[index]!.settle(movement, journal);
  const surviving: MeleeState[] = [];
  const projectileStep = stepProjectiles(
    bullets,
    next,
    moved,
    world,
    battle,
    budget,
    journal,
    step,
    () => {
      work.candidate();
    },
    nextLedger,
  );
  effects.push(...projectileStep.effects);
  for (const attack of attacks) {
    const ownerActor = next.find((a) => actorId(a) === attack.actorId)!;
    if (
      attack.stage &&
      (ownerActor.actions.action?.id !== attack.stage.actionId ||
        ownerActor.actions.action.stages?.interruptedAt !== undefined)
    )
      continue;
    const shape = attack.ability.definition.attack;
    if (shape.kind !== 'melee' && shape.kind !== 'arc' && shape.kind !== 'radial')
      throw new Error('Invalid attached attack');
    const owner = moved.find((a) => a.state.actor.participant.actorId === attack.actorId)!;
    const enemy = moved.find((a) => a.state.actor.participant.actorId !== attack.actorId)!;
    const activeSteps =
      shape.kind === 'melee'
        ? shape.activeSteps
        : ownerActor.actions.action!.ability.definition.stages![attack.stage!.stageIndex]!
            .durationSteps;
    work.candidate();
    const blade =
      shape.kind !== 'melee'
        ? sweepBlade(
            world,
            owner.trace,
            attack.offset,
            attack.direction,
            shape,
            step - attack.launchStep,
            activeSteps,
            enemy.state,
            enemy.trace,
            battle.rules,
            budget,
          )
        : null;
    const trace =
      shape.kind === 'melee'
        ? meleeTrace(
            owner.trace,
            attack.offset,
            attack.direction,
            Math.min(shape.reachMm, attack.ability.definition.rangeMm) / 1000,
            step - attack.launchStep,
            shape.activeSteps,
          )
        : [];
    const blocking: { wall: AttackContact | null } = { wall: blade?.wall ?? null };
    const contact =
      shape.kind === 'melee'
        ? traceAttack(
            world,
            trace,
            shape.radiusMm / 1000,
            enemy.state,
            enemy.trace,
            attack.stage ? blocking : undefined,
          )
        : blade!.contact;
    if (attack.stage)
      ownerActor.actions.action!.stages!.geometry =
        shape.kind === 'melee'
          ? {
              kind: 'sphere',
              radiusMm: shape.radiusMm,
              segments: blocking.wall ? clipTrace(trace, blocking.wall.time) : trace,
            }
          : blade!.geometry;
    if (contact) {
      const admission =
        contact.kind === 'body' && attack.stage
          ? nextLedger.contact(
              attack.stage,
              attack.hit,
              enemy.state.actor.participant.actorId,
              step,
            )
          : null;
      const hit = journal.emit({
        kind:
          contact.kind === 'body'
            ? admission?.accepted === false
              ? 'diagnostic'
              : 'hit'
            : 'fizzle',
        step,
        phase: 'contact',
        subtimeMicros: Math.round(contact.time * 1_000_000),
        actorId: attack.actorId,
        targetId: contact.kind === 'body' ? enemy.state.actor.participant.actorId : null,
        abilityId: attack.ability.id,
        parentEventId: attack.cause,
        point: contact.point,
        ruleId: `${shape.kind}.first-contact`,
        reason: admission?.reason ?? contact.kind,
        ...(attack.stage ? { stage: attack.stage } : {}),
      });
      if (contact.kind === 'body' && admission?.accepted !== false) {
        attack.hits++;
        for (const effect of attack.ability.definition.effects)
          effects.push({
            actorId: attack.actorId,
            targetId: enemy.state.actor.participant.actorId,
            effect,
            ...copyDamageSnapshot(attack),
            parentEventId: hit.id,
            abilityId: attack.ability.id,
            ...(attack.stage ? { stage: attack.stage } : {}),
            observation: contactObservation(
              moved,
              next.find((a) => actorId(a) === attack.actorId)!.body.motion,
              next.find((a) => actorId(a) !== attack.actorId)!.body.motion,
              contact.time,
            ),
          });
      }
    }
    if (blocking.wall && contact?.kind === 'body')
      journal.emit({
        kind: 'fizzle',
        step,
        phase: 'contact',
        subtimeMicros: Math.round(blocking.wall.time * 1_000_000),
        actorId: attack.actorId,
        abilityId: attack.ability.id,
        parentEventId: attack.cause,
        point: blocking.wall.point,
        ruleId: `${shape.kind}.blocking-wall`,
        reason: 'wall',
        ...(attack.stage ? { stage: attack.stage } : {}),
      });
    if (
      contact?.kind !== 'wall' &&
      !blocking.wall &&
      (attack.stage || (shape.kind === 'melee' && attack.hits < shape.maxHitsPerTarget)) &&
      step + 1 < attack.launchStep + activeSteps
    )
      surviving.push(attack);
  }
  for (const actor of next) {
    const movement = moved.find((m) => m.state.actor.participant.actorId === actorId(actor))!;
    actor.body.motion = movement.state;
    settleForcedInterval(actor, forcePlans.get(actorId(actor)) ?? null, movement, step);
    if (movement.landed) {
      const land = journal.emit({
        kind: 'land',
        step,
        phase: 'contact',
        subtimeMicros: 1_000_000,
        actorId: actorId(actor),
        ruleId: 'movement.land',
        point: actor.body.motion.position,
        amount: movement.fallDamage,
      });
      if (movement.fallDamage)
        effects.push({
          actorId: null,
          targetId: actorId(actor),
          attack: 0,
          effect: {
            kind: 'damage',
            amount: movement.fallDamage,
            attackScaleBps: 0,
            element: 'physical',
          },
          parentEventId: land.id,
          abilityId: null,
        });
    }
  }

  tx.next.melees = surviving;
  tx.next.projectiles = projectileStep.alive;
  tx.paths = [
    ...moved.map((m) => ({ entityId: m.state.actor.participant.actorId, segments: m.trace })),
    ...projectileStep.paths,
  ];
  tx.projectileChanges = { ...projectileStep.changes, spawn: tx.spawns };
}
