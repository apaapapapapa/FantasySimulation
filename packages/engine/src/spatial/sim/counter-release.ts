import type { ActorState, PreparedBattle } from '../state.ts';
import type { PendingEffect } from './combat-effects.ts';
import type { Journal } from '../rules/journal.ts';
import type { HitLedger } from '../rules/hit-ledger.ts';
import { hitscan, inObservedRange, launchDirection } from '../rules/attacks.ts';
import { bodyPoint } from '../world/visibility.ts';
import { conditionMatches } from '../rules/conditions.ts';
import { selfView } from '../ai/self-view.ts';
import { blockedBySilence } from '../rules/categories.ts';
import { postureAllows } from '../rules/posture.ts';
import { reactionPayload } from './reactions.ts';
import { add, mul } from '../math.ts';
import { straight, type SpatialWorld } from '../world/physics.ts';

/** Paid counters occupy their own slot. Release never charges or changes the main action. */
export function releaseCounters(
  actors: ActorState[],
  battle: PreparedBattle,
  journal: Journal,
  world: SpatialWorld,
  step: number,
  ledger: HitLedger,
  countCandidate: () => void,
): PendingEffect[] {
  const effects: PendingEffect[] = [];
  for (const actor of actors) {
    const actorId = actor.body.motion.actor.participant.actorId;
    for (const reaction of actor.actions.reactions ?? []) {
      if (reaction.state !== 'queued' || reaction.readyAt > step) continue;
      const ability = actor.body.motion.actor.abilities.find((a) => a.id === reaction.abilityId)!;
      const definition = ability.definition;
      const view = selfView(actor, step, battle.rules.ai, battle.statuses);
      const enemy = actors.find(
        (a) => a.body.motion.actor.participant.actorId === reaction.targetId,
      )!;
      const valid =
        actor.vitals.resources.hp > 0 &&
        enemy.vitals.resources.hp > 0 &&
        !view.incapacitated &&
        postureAllows(actor.body.motion, definition) &&
        !(view.silenced && blockedBySilence(definition)) &&
        conditionMatches(definition.condition, view) &&
        inObservedRange(definition, view);
      reaction.state = valid ? 'released' : 'cancelled';
      const launch = journal.emit({
        kind: 'reaction',
        step,
        phase: 'launch',
        actorId,
        targetId: reaction.targetId,
        abilityId: ability.id,
        parentEventId: reaction.context.activationId,
        reaction: reaction.context,
        ruleId: valid ? 'reaction.release' : 'reaction.cancelled',
        reason: valid
          ? 'paid-counter'
          : 'release-condition-range-or-capability; paid cost retained',
      });
      if (!valid) continue;
      if (definition.attack.kind !== 'hitscan') throw new Error('Unsupported counter geometry');
      const aim = launchDirection(
        actor.body.motion.facing,
        definition.aimErrorMilliDegrees,
        actor.mind.random,
      );
      actor.mind.random = aim.random;
      countCandidate();
      const contact = hitscan(
        world,
        actor.body.motion,
        enemy.body.motion,
        aim.direction,
        definition.rangeMm / 1000,
        definition.attack.radiusMm / 1000,
      );
      const origin = bodyPoint(
        actor.body.motion,
        actor.body.motion.actor.character.body.muzzleOffset,
      );
      reaction.geometry = {
        kind: 'ray',
        radiusMm: definition.attack.radiusMm,
        segments: straight(
          origin,
          contact?.center ?? add(origin, mul(aim.direction, definition.rangeMm / 1000)),
        ),
      };
      if (!contact) continue;
      const hit = journal.emit({
        kind: contact.kind === 'body' ? 'hit' : 'fizzle',
        step,
        phase: 'contact',
        actorId,
        targetId: contact.kind === 'body' ? reaction.targetId : null,
        abilityId: ability.id,
        parentEventId: launch.id,
        reaction: reaction.context,
        ruleId: 'reaction.first-contact',
        point: contact.point,
        reason: contact.kind,
      });
      if (contact.kind !== 'body') continue;
      const accepted = ledger.contact(
        {
          actionId: reaction.context.activationId,
          stageId: 'reaction',
          stageIndex: 0,
          emitterId: 0,
          hitGroupId: 'counter',
        },
        undefined,
        reaction.targetId,
        step,
      );
      if (!accepted.accepted) throw new Error('Counter activation released twice');
      effects.push(
        ...reactionPayload(actor, ability, reaction, hit.id, step).map((app) => ({
          ...app,
          observation: { self: actor.body.motion, target: enemy.body.motion },
        })),
      );
    }
  }
  return effects;
}
