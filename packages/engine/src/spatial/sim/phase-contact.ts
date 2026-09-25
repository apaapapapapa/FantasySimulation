import type { MeleeState } from '../state.ts';
import { contactAttack, isAttachedAttack } from '../rules/attack-contact.ts';
import { contactObservation } from './combat-effects.ts';
import { moveActors } from '../world/movement.ts';
import { reserveMotion } from '../rules/motion-resources.ts';
import { isDodgeDecision } from '../ai/policy.ts';
import { stepProjectiles } from './projectile-step.ts';
import { copyDamageSnapshot } from '../rules/status-damage.ts';
import { settleForcedInterval } from '../rules/forces.ts';
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
    if (!isAttachedAttack(shape)) throw new Error('Invalid attached attack');
    const owner = moved.find((a) => a.state.actor.participant.actorId === attack.actorId)!;
    const enemy = moved.find((a) => a.state.actor.participant.actorId !== attack.actorId)!;
    work.candidate();
    const result = contactAttack(shape, {
      world,
      source: owner.state,
      target: enemy.state,
      trace: owner.trace,
      targetTrace: enemy.trace,
      direction: attack.direction,
      offset: attack.offset,
      rangeMm: attack.ability.definition.rangeMm,
      elapsedSteps: step - attack.launchStep,
      stageDuration:
        ownerActor.actions.action?.ability.definition.stages?.[attack.stage?.stageIndex ?? -1]
          ?.durationSteps,
      staged: !!attack.stage,
      rules: battle.rules,
      budget,
    });
    const { contact, activeSteps } = result,
      blocking = { wall: result.blocking };
    if (attack.stage && result.geometry)
      ownerActor.actions.action!.stages!.geometry = result.geometry;
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
      (attack.stage || attack.hits < result.maxHits) &&
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
