import {
  canonicalJson,
  compareIds,
  type StageContact,
  type Stage,
  type InterferenceCause,
} from '@fantasy/domain/spatial/execution';
import { boundedInterferences } from './interference.ts';
import type { AbilityRevision, ActorState } from '../state.ts';
import { add, length, sub, type Vec3 } from '../math.ts';
import { SpatialBudgetError } from '../world/physics.ts';
import { bodyCapsule, metres, terrainObstacles } from '../world/terrain.ts';
import {
  objectGeometry,
  objectSweep,
  objectSweepsBody,
  objectsOverlap,
  objectTouchesBody,
  shapeFits,
} from '../world/object-geometry.ts';
import { blocksQuery } from '../geometry-types.ts';
import { relocationDestination } from '../rules/relocation.ts';
import { statusDamageSource } from '../rules/status-damage.ts';
import { barrierObstacle, type SpatialObject } from '../rules/spatial-objects.ts';
import { blockedBySilence } from '../rules/categories.ts';
import { selfView } from '../ai/self-view.ts';
import { type StepTransaction, actorId } from './step-transaction.ts';

export function spatialSourceAllowed(
  tx: StepTransaction,
  command: { ownerId: string; actionId: string; ability: AbilityRevision },
): boolean {
  const actor = tx.next.actors.find((a) => actorId(a) === command.ownerId);
  if (
    !actor ||
    actor.actions.action?.id !== command.actionId ||
    actor.actions.action.stages?.interruptedAt !== undefined ||
    actor.vitals.resources.hp <= 0
  )
    return false;
  const view = selfView(actor, tx.step, tx.context.battle.rules.ai, tx.context.battle.statuses);
  return !view.incapacitated && !(view.silenced && blockedBySilence(command.ability.definition));
}
export function spatialBudgets(tx: StepTransaction, cause: string) {
  const objects = tx.next.objects ?? [],
    pending = tx.next.relocations ?? [];
  for (const [resource, observed, limit] of [
    ['spatial-objects', objects.length, tx.context.budget.maxSpatialObjects ?? 64],
    [
      'spatial-commands',
      pending.length + objects.filter((o) => o.launchStep === tx.step).length,
      tx.context.budget.maxSpatialCommands ?? 64,
    ],
  ] as const)
    if (observed > limit) {
      const commands =
        resource === 'spatial-objects'
          ? objects
          : [...pending, ...objects.filter((o) => o.launchStep === tx.step)];
      const causes = commands.map((command): InterferenceCause => {
        const ordinal = tx.journal.events.findIndex((event) => event.id === command.cause);
        if (ordinal < 0) return { kind: 'event', eventId: command.cause };
        return {
          kind: 'attempt',
          step: tx.step,
          point: 'contact',
          wave: 0,
          actorId: command.ownerId,
          ordinal,
          ability: {
            id: command.ability.id,
            revision: command.ability.revision,
            contentHash: command.ability.contentHash,
          },
        };
      });
      const revisions = commands.map(({ ability: a }) => ({
        kind: 'ability' as const,
        id: a.id,
        revision: a.revision,
        contentHash: a.contentHash,
      }));
      throw new SpatialBudgetError(resource, undefined, {
        observed,
        limit,
        cause,
        context: boundedInterferences([
          {
            step: tx.step,
            point: 'contact',
            wave: 0,
            actors: [...new Set(commands.map((c) => c.ownerId))].sort(compareIds),
            causes: [...new Map(causes.map((c) => [canonicalJson(c), c])).values()],
            revisions: [...new Map(revisions.map((r) => [canonicalJson(r), r])).values()],
            ruleId: resource,
          },
        ]),
      });
    }
}
export function queueSpatialObject(
  tx: StepTransaction,
  actor: ActorState,
  ability: AbilityRevision,
  cause: string,
  stage?: StageContact,
  hit?: Stage['hit'],
  aim?: Vec3,
) {
  const definition = ability.definition,
    shape = definition.attack,
    barrier = definition.barrier;
  if (!barrier && shape.kind !== 'area' && shape.kind !== 'beam')
    throw new Error('Invalid object command');
  const placement = barrier?.placement ?? (shape.kind === 'area' ? shape.placement : undefined);
  const position = placement
    ? relocationDestination(placement, actor.body.motion, actor.mind.memory.observation?.enemy)
    : { ...actor.body.motion.position };
  if (!position) {
    tx.journal.emit({
      kind: 'fizzle',
      step: tx.step,
      phase: 'launch',
      actorId: actorId(actor),
      abilityId: ability.id,
      parentEventId: cause,
      ruleId: 'spatial.anchor',
      reason: 'No delivered visible anchor; cost retained',
    });
    return;
  }
  const duration =
    barrier?.durationSteps ??
    (shape.kind === 'area'
      ? shape.durationSteps
      : actor.actions.action?.ability.definition.stages?.[stage?.stageIndex ?? -1]?.durationSteps);
  if (!duration) throw new Error('Missing object lifetime');
  const activeFrom = tx.step + (shape.kind === 'beam' ? 0 : 1),
    actionId = actor.actions.action!.id;
  const common = {
    id: `object.${stage ? `${actionId}.${stage.stageIndex}` : actionId}`,
    ownerId: actorId(actor),
    ownerSlot: actor.body.motion.actor.participant.rngStream,
    ordinal: tx.next.serial++,
    ability,
    actionId,
    cause,
    launchStep: tx.step,
    activeFrom,
    endStep: activeFrom + duration,
    position,
    active: shape.kind === 'beam',
    ...statusDamageSource(actor, ability, tx.step),
    ...(stage ? { stage } : {}),
    ...(hit ? { hit } : {}),
  };
  const offset = sub(position, actor.body.motion.position);
  const object: SpatialObject = barrier
    ? { ...common, kind: 'barrier', spec: barrier, durability: barrier.durability, offset }
    : shape.kind === 'area'
      ? { ...common, kind: 'area', spec: shape }
      : shape.kind === 'beam' && aim
        ? { ...common, kind: 'beam', spec: shape, direction: aim, offset }
        : (() => {
            throw new Error('Beam direction missing');
          })();
  (tx.next.objects ??= []).push(object);
  spatialBudgets(tx, cause);
}
function geometry(tx: StepTransaction) {
  tx.replaceGeometry([
    ...terrainObstacles(tx.context.battle.scenario),
    ...(tx.next.objects ?? []).flatMap((o) =>
      o.active && o.kind === 'barrier' ? [barrierObstacle(o)] : [],
    ),
  ]);
}
function remove(
  tx: StepTransaction,
  object: SpatialObject,
  reason: 'expired' | 'broken' | 'source-interrupted',
) {
  tx.objectRemovals.set(object.id, reason);
  tx.journal.emit({
    kind: 'diagnostic',
    phase: 'boundary',
    step: tx.step,
    actorId: object.ownerId,
    abilityId: object.ability.id,
    parentEventId: object.cause,
    ruleId: 'spatial.object-remove',
    reason,
  });
}
/** Expiry/breakage precedes boundary pulses. Geometry is rebuilt only if the set/poses changed. */
export function expireSpatialObjects(tx: StepTransaction) {
  if (!tx.next.objects?.length) return;
  tx.next.objects = tx.next.objects.filter((o) => {
    const reason =
      o.endStep <= tx.step
        ? 'expired'
        : o.kind === 'barrier' && o.durability === 0
          ? 'broken'
          : null;
    if (reason) remove(tx, o, reason);
    return !reason;
  });
  geometry(tx);
}
export function activateSpatialObjects(tx: StepTransaction) {
  if (!tx.next.objects?.length) return;
  const { world, battle, work } = tx.context;
  tx.next.objects = tx.next.objects.filter((o) => {
    const attached = o.kind === 'beam' || (o.kind === 'barrier' && o.spec.attachment === 'follow');
    if ((attached || !o.active) && !spatialSourceAllowed(tx, o)) {
      remove(tx, o, 'source-interrupted');
      return false;
    }
    return true;
  });
  const old = [
    ...terrainObstacles(battle.scenario),
    ...tx.next.objects.flatMap((o) =>
      o.active && o.kind === 'barrier' ? [barrierObstacle(o)] : [],
    ),
  ];
  const min = metres(battle.scenario.bounds.min),
    max = metres(battle.scenario.bounds.max);
  const followers = tx.next.objects.flatMap((o) => {
    if (!o.active || o.kind !== 'barrier' || o.spec.attachment !== 'follow') return [];
    const owner = tx.next.actors.find((a) => actorId(a) === o.ownerId)!,
      destination = add(owner.body.motion.position, o.offset),
      obstacle = barrierObstacle(o);
    work.candidate();
    const held =
      !shapeFits({ ...obstacle, position: destination }, min, max) ||
      old.some((other) => other.id !== o.id && objectSweep(world, obstacle, destination, other)) ||
      tx.next.actors.some(
        (a) =>
          blocksQuery(obstacle, 'movement', { ownerId: actorId(a) }) &&
          objectSweepsBody(
            world,
            obstacle,
            destination,
            a.body.motion.position,
            bodyCapsule(a.body.motion.actor.character.body),
          ),
      );
    return [{ object: o, obstacle, destination, held }];
  });
  for (let i = 0; i < followers.length; i++)
    for (let j = i + 1; j < followers.length; j++) {
      const a = followers[i]!,
        b = followers[j]!;
      work.candidate();
      if (objectSweep(world, a.obstacle, a.destination, b.obstacle, b.destination))
        a.held = b.held = true;
    }
  for (const p of followers) {
    if (!p.held) p.object.position = p.destination;
    else if (length(sub(p.destination, p.object.position)) > 1e-12)
      tx.journal.emit({
        kind: 'diagnostic',
        phase: 'boundary',
        step: tx.step,
        actorId: p.object.ownerId,
        abilityId: p.object.ability.id,
        parentEventId: p.object.cause,
        ruleId: 'barrier.follow-held',
        reason: 'swept-conflict',
      });
  }
  const occupied = [
    ...terrainObstacles(battle.scenario),
    ...tx.next.objects.flatMap((o) =>
      o.active && o.kind === 'barrier' ? [barrierObstacle(o)] : [],
    ),
  ];
  const proposals = tx.next.objects.flatMap((o) => {
    if (o.active || o.activeFrom !== tx.step || o.kind === 'beam') return [];
    work.candidate();
    const owner = tx.next.actors.find((a) => actorId(a) === o.ownerId)!,
      obstacle =
        o.kind === 'barrier' ? barrierObstacle(o) : objectGeometry(o.id, o.spec.shape, o.position);
    const reason = tx.next.actors.some((a) => a.vitals.resources.hp === 0)
      ? 'battle-ended'
      : length(sub(o.position, owner.body.motion.position)) > o.spec.placement.maxDistanceMm / 1000
        ? 'range'
        : !shapeFits(obstacle, min, max)
          ? 'arena'
          : o.kind === 'barrier' &&
              (occupied.some((other) => objectsOverlap(world, obstacle, other)) ||
                tx.next.actors.some(
                  (a) =>
                    blocksQuery(obstacle, 'movement', { ownerId: actorId(a) }) &&
                    objectTouchesBody(
                      world,
                      obstacle,
                      a.body.motion.position,
                      bodyCapsule(a.body.motion.actor.character.body),
                    ),
                ))
            ? 'occupied'
            : null;
    return [{ object: o, obstacle, reason }];
  });
  for (let i = 0; i < proposals.length; i++)
    for (let j = i + 1; j < proposals.length; j++) {
      const a = proposals[i]!,
        b = proposals[j]!;
      if (a.object.kind === 'barrier' && b.object.kind === 'barrier') {
        work.candidate();
        if (objectsOverlap(world, a.obstacle, b.obstacle))
          a.reason = b.reason = 'placement-conflict';
      }
    }
  const failed = new Set<string>();
  for (const { object, reason } of proposals) {
    tx.journal.emit({
      kind: reason ? 'fizzle' : 'diagnostic',
      phase: 'boundary',
      step: tx.step,
      actorId: object.ownerId,
      abilityId: object.ability.id,
      parentEventId: object.cause,
      ruleId: 'spatial.object-activation',
      reason: reason ?? object.kind,
      ...(object.stage ? { stage: object.stage } : {}),
    });
    if (reason) failed.add(object.id);
    else object.active = true;
  }
  tx.next.objects = tx.next.objects.filter((o) => !failed.has(o.id));
  geometry(tx);
}
export function cancelEndedObjects(tx: StepTransaction) {
  if (
    tx.step + 1 < tx.context.battle.rules.maxSteps &&
    tx.next.actors.every((a) => a.vitals.resources.hp > 0)
  )
    return;
  if (!tx.next.objects) return;
  tx.next.objects = tx.next.objects.filter((o) => {
    if (!o.active)
      tx.journal.emit({
        kind: 'fizzle',
        phase: 'resolution',
        step: tx.step + 1,
        actorId: o.ownerId,
        abilityId: o.ability.id,
        parentEventId: o.cause,
        ruleId: 'spatial.object-activation',
        reason: 'battle-ended',
      });
    return o.active;
  });
}
