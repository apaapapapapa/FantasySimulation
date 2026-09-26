import type { StageContact, Stage } from '@fantasy/domain/spatial/execution';
import type { AbilityRevision, DamageSnapshot } from '../state.ts';
import type { AttackContact } from '../rules/attacks.ts';
import { calculateDamage } from '../rules/damage.ts';
import { barrierObstacle } from '../rules/spatial-objects.ts';
import { closestObjectPoint } from '../world/object-geometry.ts';
import { capsuleObstacleContact } from '../world/geometry.ts';
import { CONTACT_TOLERANCE, type SpatialWorld } from '../world/physics.ts';
import { length, sub } from '../math.ts';
import type { StepTransaction } from './step-transaction.ts';

type BarrierSource = DamageSnapshot & {
  ownerId: string;
  ability: AbilityRevision;
  cause: string;
  stage?: StageContact;
  hit?: Stage['hit'];
};
/** All epsilon-tied blockers receive the request; a static surface in the tie shields them. */
export function barrierBlockers(
  world: SpatialWorld,
  contact: AttackContact,
  radius: number,
): string[] {
  if (contact.kind !== 'wall') return [];
  const obstacles = world.obstacles('attack');
  if (!obstacles.some((o) => o.ownerId)) return [];
  world.countCast();
  const tied = obstacles.filter(
    (o) =>
      contact.obstacleIds?.includes(o.id) ||
      capsuleObstacleContact(contact.center, { radius, halfHeight: 0 }, o).distance <=
        CONTACT_TOLERANCE,
  );
  return tied.some((o) => !o.ownerId) ? [] : tied.map((o) => o.id);
}
function request(tx: StepTransaction, source: BarrierSource, targetId: string, scaleBps: number) {
  const target = tx.next.objects?.find(
    (o) => o.id === targetId && o.active && o.kind === 'barrier',
  );
  if (!target || scaleBps <= 0) return;
  if (source.stage && !tx.next.ledger.contact(source.stage, source.hit, targetId, tx.step).accepted)
    return;
  let amount = 0;
  for (const effect of source.ability.definition.effects) {
    if (effect.kind !== 'damage') continue;
    amount += Number(
      calculateDamage(effect, source, { defense: 0, resistance: 0 }, scaleBps, {
        dealtBps: source.dealtByElement?.[effect.element] ?? 10000,
        receivedBps: 10000,
      }).afterModifiers,
    );
  }
  tx.barrierDamage.set(targetId, (tx.barrierDamage.get(targetId) ?? 0) + amount);
  tx.journal.emit({
    kind: 'diagnostic',
    phase: 'contact',
    step: tx.step,
    actorId: source.ownerId,
    entityId: targetId,
    abilityId: source.ability.id,
    parentEventId: source.cause,
    ruleId: 'barrier.damage-request',
    amount,
    reason: 'source-snapshot; no body payload',
    ...(source.stage ? { stage: source.stage } : {}),
  });
}
export function damageBarrierContact(
  tx: StepTransaction,
  source: BarrierSource,
  contact: AttackContact,
  radius: number,
  explosionRadius = 0,
) {
  if (!tx.next.objects?.some((o) => o.active && o.kind === 'barrier')) return;
  const world = tx.context.world.forQuery({ ownerId: source.ownerId });
  if (explosionRadius <= 0) {
    for (const id of barrierBlockers(world, contact, radius)) request(tx, source, id, 10000);
    return;
  }
  // Strict interior never emits damage outward. Surface departure is handled by the ray adapter.
  if (
    world
      .obstacles('attack')
      .some(
        (o) =>
          capsuleObstacleContact(contact.center, { radius: 0, halfHeight: 0 }, o).distance <
          -CONTACT_TOLERANCE,
      )
  )
    return;
  for (const target of tx.next.objects) {
    if (!target.active || target.kind !== 'barrier') continue;
    const obstacle = barrierObstacle(target);
    if (!world.queryBlocks(obstacle, 'attack')) continue;
    tx.context.work.candidate();
    const point = closestObjectPoint(obstacle, contact.center),
      distance = length(sub(point, contact.center));
    const scale = Math.max(0, Math.floor((1 - distance / explosionRadius) * 10000));
    if (
      scale &&
      !world.forQuery({ ignoreObjectId: target.id }).occluded(contact.center, point, 'attack')
    )
      request(tx, source, target.id, scale);
  }
}
export function commitBarrierDamage(tx: StepTransaction) {
  for (const object of tx.next.objects ?? []) {
    if (object.kind !== 'barrier') continue;
    const amount = tx.barrierDamage.get(object.id);
    if (amount === undefined) continue;
    object.durability = Math.max(0, object.durability - amount);
  }
}
