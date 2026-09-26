import { spatialBudgets } from './spatial-commands.ts';
import type { Relocation, StageContact } from '@fantasy/domain/spatial/execution';
import type { AbilityRevision, ActorState } from '../state.ts';
import { length, sub } from '../math.ts';
import { capsuleShape, SpatialBudgetError } from '../world/physics.ts';
import { bodyCapsule, metres } from '../world/terrain.ts';
import { capsulesOverlap, relocationDestination } from '../rules/relocation.ts';
import { selfView } from '../ai/self-view.ts';
import { blockedBySilence } from '../rules/categories.ts';
import { type StepTransaction, actorId } from './step-transaction.ts';

export function cancelEndedRelocations(tx: StepTransaction) {
  if (
    tx.step + 1 < tx.context.battle.rules.maxSteps &&
    tx.next.actors.every((a) => a.vitals.resources.hp > 0)
  )
    return;
  for (const p of tx.next.relocations ?? [])
    tx.journal.emit({
      kind: 'fizzle',
      phase: 'resolution',
      step: tx.step + 1,
      actorId: p.ownerId,
      abilityId: p.ability.id,
      parentEventId: p.cause,
      ruleId: 'teleport.activation',
      reason: 'battle-ended',
      ...(p.stage ? { stage: p.stage } : {}),
    });
  delete tx.next.relocations;
}
export function queueRelocation(
  tx: StepTransaction,
  actor: ActorState,
  ability: AbilityRevision,
  cause: string,
  spec: Readonly<Relocation>,
  stage?: StageContact,
) {
  const destination = relocationDestination(
    spec,
    actor.body.motion,
    actor.mind.memory.observation?.enemy,
  );
  if (!destination) {
    tx.journal.emit({
      kind: 'fizzle',
      phase: 'launch',
      step: tx.step,
      actorId: actorId(actor),
      abilityId: ability.id,
      parentEventId: cause,
      ruleId: 'teleport.anchor',
      reason: 'No delivered visible anchor; cost retained',
    });
    return;
  }
  const pending = (tx.next.relocations ??= []);
  pending.push({
    ownerId: actorId(actor),
    actionId: actor.actions.action!.id,
    ability,
    cause,
    at: tx.step + 1,
    destination,
    maxDistanceMm: spec.maxDistanceMm,
    ...(stage ? { stage } : {}),
  });
  spatialBudgets(tx, cause);
  const limit = tx.context.budget.maxSpatialCommands ?? 64;
  if (pending.length > limit)
    throw new SpatialBudgetError('spatial-commands', undefined, {
      observed: pending.length,
      limit,
      cause,
    });
  if (pending.filter((p) => p.ownerId === actorId(actor) && p.at === tx.step + 1).length > 1)
    throw new Error('Multiple due relocations for one actor');
}

export function activateRelocations(tx: StepTransaction) {
  const pending = tx.next.relocations;
  if (!pending?.length) return;
  const { world, battle, work } = tx.context;
  const actors = tx.next.actors;
  const due = pending.filter((p) => p.at === tx.step);
  const proposals = due.map((command) => {
    work.candidate();
    const actor = actors.find((a) => actorId(a) === command.ownerId)!;
    const motion = actor.body.motion,
      body = bodyCapsule(motion.actor.character.body);
    const view = selfView(actor, tx.step, battle.rules.ai, battle.statuses);
    const permitted =
      actor.actions.action?.id === command.actionId &&
      actor.actions.action.stages?.interruptedAt === undefined &&
      actor.vitals.resources.hp > 0 &&
      !view.incapacitated &&
      !(view.silenced && blockedBySilence(command.ability.definition));
    const min = metres(battle.scenario.bounds.min),
      max = metres(battle.scenario.bounds.max),
      p = command.destination;
    const height = body.radius + body.halfHeight;
    const reason = actors.some((a) => a.vitals.resources.hp === 0)
      ? 'battle-ended'
      : !permitted
        ? 'source-interrupted'
        : length(sub(p, motion.position)) > command.maxDistanceMm / 1000
          ? 'range'
          : p.x - body.radius < min.x ||
              p.x + body.radius > max.x ||
              p.y - height < min.y ||
              p.y + height > max.y ||
              p.z - body.radius < min.z ||
              p.z + body.radius > max.z
            ? 'arena'
            : world.forQuery({ ownerId: command.ownerId }).overlaps(p, capsuleShape(body))
              ? 'obstacle'
              : actors.some(
                    (other) =>
                      other !== actor &&
                      capsulesOverlap(
                        p,
                        body,
                        other.body.motion.position,
                        bodyCapsule(other.body.motion.actor.character.body),
                      ),
                  )
                ? 'occupied'
                : null;
    return { command, actor, body, reason };
  });
  // Even an invalid destination reserves its candidate volume for this subphase.
  for (let i = 0; i < proposals.length; i++)
    for (let j = i + 1; j < proposals.length; j++) {
      work.candidate();
      const a = proposals[i]!,
        b = proposals[j]!;
      if (capsulesOverlap(a.command.destination, a.body, b.command.destination, b.body)) {
        a.reason = 'endpoint-conflict';
        b.reason = 'endpoint-conflict';
      }
    }
  for (const { command, actor, reason } of proposals) {
    const from = { ...actor.body.motion.position };
    tx.journal.emit({
      kind: reason ? 'fizzle' : 'teleport',
      phase: 'boundary',
      step: tx.step,
      actorId: command.ownerId,
      abilityId: command.ability.id,
      parentEventId: command.cause,
      ruleId: 'teleport.activation',
      reason: reason ?? 'relocated',
      ...(command.stage ? { stage: command.stage } : {}),
      ...(!reason ? { teleport: { from, to: { ...command.destination } } } : {}),
    });
    if (reason) continue;
    actor.body.motion.position = { ...command.destination };
    actor.body.motion.grounded = false;
    tx.context.navigators.get(command.ownerId)?.invalidate();
    if (actor.body.motionClock) delete actor.body.motionClock.dodgeUntilStep;
    if (actor.body.locomotion) actor.body.locomotion.dodging = false;
    if (actor.actions.action?.stages) delete actor.actions.action.stages.geometry;
  }
  tx.next.relocations = pending.filter((p) => p.at > tx.step);
}
