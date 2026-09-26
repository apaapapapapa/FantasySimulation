import type { MovedActor } from '../world/movement.ts';
import { objectGeometry } from '../world/object-geometry.ts';
import { areaContact, beamContact } from '../rules/object-contact.ts';
import { copyDamageSnapshot } from '../rules/status-damage.ts';
import { at } from '../world/physics.ts';
import { bodyPoint } from '../world/visibility.ts';
import { sub, unit } from '../math.ts';
import { contactObservation } from './combat-effects.ts';
import { opponentInDuel } from './duel.ts';
import { damageBarrierContact } from './barrier-damage.ts';
import { type StepTransaction, actorId } from './step-transaction.ts';

export function contactSpatialObjects(tx: StepTransaction, moved: readonly MovedActor[]) {
  for (const object of tx.next.objects ?? []) {
    if (
      !object.active ||
      object.kind === 'barrier' ||
      tx.step < object.activeFrom ||
      tx.step >= object.endStep
    )
      continue;
    const owner = tx.next.actors.find((a) => actorId(a) === object.ownerId)!,
      target = opponentInDuel(moved, object.ownerId, (a) => a.state.actor.participant.actorId),
      targetId = target.state.actor.participant.actorId;
    const world = tx.context.world.forQuery({ ownerId: object.ownerId });
    tx.context.work.candidate();
    let contact: { time: number; point: typeof object.position } | null;
    if (object.kind === 'area') {
      contact = areaContact(
        world,
        objectGeometry(object.id, object.spec.shape, object.position),
        target.state,
        target.trace,
      );
      if (contact && world.occluded(object.position, contact.point, 'attack')) contact = null;
      const pulse =
        tx.step >= object.activeFrom + object.spec.armDelaySteps &&
        (tx.step - object.activeFrom - object.spec.armDelaySteps) % object.spec.periodSteps === 0;
      if (!pulse) {
        if (contact && object.stage) tx.next.ledger.occupy(object.stage, targetId, tx.step);
        continue;
      }
    } else {
      const motion = moved.find((a) => a.state.actor.participant.actorId === object.ownerId)!;
      const offset = sub(
        bodyPoint(owner.body.motion, owner.body.motion.actor.character.body.muzzleOffset),
        owner.body.motion.position,
      );
      const result = beamContact(
        world,
        motion.trace,
        offset,
        object.direction,
        object.ability.definition.rangeMm / 1000,
        object.spec.radiusMm / 1000,
        target.state,
        target.trace,
        tx.context.budget.maxCurveSegments,
      );
      object.position = at(motion.trace, 1);
      object.geometry = result.geometry;
      contact = result.contact;
      for (const wall of result.walls)
        damageBarrierContact(tx, object, wall, object.spec.radiusMm / 1000);
    }
    if (!contact) continue;
    const admission = object.stage
      ? tx.next.ledger.contact(object.stage, object.hit, targetId, tx.step)
      : null;
    const hit = tx.journal.emit({
      kind: admission?.accepted === false ? 'diagnostic' : 'hit',
      phase: 'contact',
      step: tx.step,
      subtimeMicros: Math.round(contact.time * 1000000),
      actorId: object.ownerId,
      targetId,
      entityId: object.id,
      abilityId: object.ability.id,
      parentEventId: object.cause,
      ruleId: `${object.kind}.contact`,
      point: contact.point,
      reason: admission?.reason ?? 'accepted',
      ...(object.stage ? { stage: object.stage } : {}),
    });
    if (admission?.accepted === false) continue;
    for (const effect of object.ability.definition.effects)
      tx.effects.push({
        actorId: object.ownerId,
        targetId,
        effect,
        ...copyDamageSnapshot(object),
        parentEventId: hit.id,
        abilityId: object.ability.id,
        ...(object.stage ? { stage: object.stage } : {}),
        incomingDirection: unit(
          object.kind === 'area'
            ? sub(object.position, contact.point)
            : { x: -object.direction.x, y: -object.direction.y, z: -object.direction.z },
        ),
        observation: contactObservation(
          moved,
          owner.body.motion,
          tx.next.actors.find((a) => actorId(a) === targetId)!.body.motion,
          contact.time,
        ),
      });
  }
}
