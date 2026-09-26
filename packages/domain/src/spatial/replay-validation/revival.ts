import type { BattleEvent } from '../records.ts';
import type { ActorDisplay, StreamRecord } from '../stream.ts';
import type { ReplayContext } from './context.ts';
import { revivalHp } from '../status-sealing.ts';
import { requireReplay, same } from './common.ts';

export function validateRevival(
  context: ReplayContext,
  event: BattleEvent,
  events: readonly BattleEvent[],
) {
  if (!event.revival && event.ruleId !== 'reaction.activated') return;
  const owner = context.actors.find((a) => a.participant.actorId === event.actorId);
  const ability = owner?.abilities.find((a) => a.id === event.abilityId);
  const response = ability?.definition.reaction?.response;
  if (event.ruleId === 'reaction.activated' && response?.kind === 'revive')
    requireReplay(
      events.filter((e) => e.revival && e.parentEventId === event.id).length === 1,
      'revival activation count',
    );
  if (!event.revival) return;
  const activation = events.find((e) => e.id === event.parentEventId);
  const hp =
    response?.kind === 'revive' && owner ? revivalHp(response.health, owner.character.stats.hp) : 0;
  requireReplay(
    response?.kind === 'revive' &&
      event.ruleId === 'reaction.revive' &&
      event.actorId === event.targetId &&
      event.before?.hp === 0 &&
      event.after?.hp === hp &&
      event.amount === hp &&
      same(event.after, { ...event.before, hp }) &&
      event.revival.use <= ability!.definition.costs.uses &&
      activation?.ruleId === 'reaction.activated' &&
      activation.actorId === event.actorId &&
      activation.abilityId === event.abilityId &&
      same(activation.reaction, event.reaction),
    'revival definition/activation/resources',
  );
}
export function validateRevivalCounts(
  prior: readonly ActorDisplay[] | undefined,
  actors: readonly ActorDisplay[],
  record: StreamRecord,
) {
  for (const actor of actors) {
    const old = prior?.find((a) => a.id === actor.id)?.revivals;
    const events =
      'events' in record ? record.events.filter((e) => e.revival && e.actorId === actor.id) : [];
    if (actor.revivals === undefined && old === undefined && !events.length) continue;
    requireReplay(
      actor.revivals === (old ?? 0) + events.length &&
        events.every((e, i) => e.revival!.use === (old ?? 0) + i + 1),
      'revival cumulative count',
    );
    if (events.length)
      requireReplay(actor.resources.hp === events.at(-1)!.after!.hp, 'revival displayed HP');
  }
}
