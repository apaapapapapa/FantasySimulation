import type { ReplayCheckpoint } from '../replay.ts';
import type { ActorDisplay, StreamRecord } from '../stream.ts';
import type { ReplayContext } from './context.ts';
import { requireReplay, same } from './common.ts';
import { sensoryCueId } from '../sensory-cues.ts';
import type { BattleEvent } from '../records.ts';

const withoutTransition = (cue: NonNullable<BattleEvent['sensoryCue']>) => {
  const { transition: _, ...recorded } = cue;
  return recorded;
};
const cueMap = (actors: readonly ActorDisplay[]) =>
  new Map(
    actors.flatMap((actor) => (actor.sensoryCues ?? []).map((cue) => [cue.id, cue] as const)),
  );

export function validateSensoryCues(
  context: ReplayContext,
  prior: ReplayCheckpoint,
  state: { actors: ActorDisplay[] },
  record: StreamRecord,
) {
  const required = record.kind === 'initial' ? record.requiredFeatures : prior.requiredFeatures;
  const before = cueMap(prior.state?.actors ?? []),
    after = cueMap(state.actors),
    all = state.actors.flatMap((actor) => actor.sensoryCues ?? []);
  requireReplay(after.size === all.length, 'duplicate sensory cue');
  if (all.length) requireReplay(required?.includes('sensory-cues-v1') === true, 'cue feature');
  const actorIds = new Set(state.actors.map((actor) => actor.id));
  const step = record.kind === 'interval' ? record.toStep : record.step;
  const beforeBoundary = record.kind === 'interval';
  for (const actor of state.actors)
    for (const cue of actor.sensoryCues ?? [])
      requireReplay(
        cue.observerId === actor.id &&
          cue.creatorId !== cue.observerId &&
          actorIds.has(cue.creatorId) &&
          cue.emittedAt <= step &&
          (beforeBoundary ? step <= cue.discoveredAt : step < cue.discoveredAt) &&
          (beforeBoundary ? step <= cue.expiresAt : step < cue.expiresAt),
        'sensory cue observer/time',
      );
  if (!('events' in record)) return;
  for (const [id, cue] of after) {
    const old = before.get(id);
    if (old) {
      requireReplay(same(old, cue), 'sensory cue mutation');
      continue;
    }
    const event = record.events.find(
      (candidate) =>
        candidate.sensoryCue?.id === id && candidate.sensoryCue.transition === 'emitted',
    );
    requireReplay(
      !!event &&
        event.actorId === cue.creatorId &&
        event.targetId === cue.observerId &&
        event.sensoryCue !== undefined &&
        same(withoutTransition(event.sensoryCue), cue) &&
        cue.id ===
          sensoryCueId(context.manifest.seed, cue.creatorId, cue.observerId, event.sequence),
      'sensory cue emission identity',
    );
  }
  for (const [id, cue] of before) {
    if (after.has(id)) continue;
    const removals = record.events.filter(
      (event) =>
        event.sensoryCue?.id === id &&
        ['discovered', 'cleansed', 'expired'].includes(event.sensoryCue.transition),
    );
    requireReplay(
      removals.length === 1 &&
        removals[0]!.actorId === cue.creatorId &&
        removals[0]!.targetId === cue.observerId,
      'sensory cue removal transition',
    );
  }
}
