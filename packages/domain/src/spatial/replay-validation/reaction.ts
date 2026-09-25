import type { ActorDisplay } from '../stream.ts';
import type { ReplayActor, ReplayContext } from './context.ts';
import { requireReplay, emittedId } from './common.ts';
export function validateReactions(
  context: ReplayContext,
  actor: ActorDisplay,
  definition: ReplayActor,
  step: number,
  nextEvent: number,
) {
  const reactions = actor.reactions ?? [];
  requireReplay(
    new Set(reactions.map((r) => r.abilityId)).size === reactions.length &&
      new Set(reactions.map((r) => r.context.activationId)).size === reactions.length &&
      reactions.filter((r) => r.state === 'queued').length <= 64,
    'reaction identity/queue',
  );
  for (const reaction of reactions) {
    const ability = definition.abilities.find((a) => a.id === reaction.abilityId);
    const response = ability?.definition.reaction?.response.kind;
    requireReplay(
      !!response &&
        ability?.definition.trigger === reaction.context.point &&
        reaction.activatedAt <= step &&
        reaction.readyAt === reaction.activatedAt &&
        reaction.recoveryUntil >= reaction.activatedAt + 2 &&
        reaction.cooldownUntil >= reaction.activatedAt &&
        context.actors.some((a) => a.participant.actorId === reaction.targetId) &&
        (response === 'counter'
          ? reaction.targetId !== actor.id && reaction.state !== 'applied'
          : reaction.targetId === actor.id && reaction.state === 'applied') &&
        (reaction.state !== 'queued' || (reaction.readyAt === step && actor.resources.hp > 0)),
      'reaction reference/clocks',
    );
    requireReplay(
      emittedId(reaction.context.activationId) < nextEvent,
      'reaction activation cursor',
    );
    const geometry = reaction.geometry;
    requireReplay((reaction.state === 'released') === !!geometry, 'reaction release geometry');
    if (geometry) {
      const shape = ability!.definition.attack;
      requireReplay(
        shape.kind === 'hitscan' &&
          geometry.kind === 'ray' &&
          geometry.radiusMm === shape.radiusMm &&
          geometry.segments.length === 1,
        'reaction geometry shape',
      );
      if (geometry.kind === 'ray') {
        const segment = geometry.segments[0]!;
        requireReplay(
          segment.from === 0 &&
            segment.to === 1 &&
            Math.hypot(
              segment.end.x - segment.start.x,
              segment.end.y - segment.start.y,
              segment.end.z - segment.start.z,
            ) <=
              ability!.definition.rangeMm / 1000 + 1e-5,
          'reaction geometry reach',
        );
      }
    }
  }
}
