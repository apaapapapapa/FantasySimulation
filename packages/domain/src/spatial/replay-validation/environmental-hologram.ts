import { environmentalHologramId } from '../environmental-holograms.ts';
import type { BattleEvent } from '../records.ts';
import type { ReplayCheckpoint } from '../replay.ts';
import type { ActorDisplay, StreamRecord } from '../stream.ts';
import type { ReplayContext } from './context.ts';
import { requireReplay, same } from './common.ts';

const withoutTransition = (value: NonNullable<BattleEvent['environmentalHologram']>) => {
  const { transition: _, ...hologram } = value;
  return hologram;
};
const hologramMap = (actors: readonly ActorDisplay[]) =>
  new Map(
    actors.flatMap((actor) =>
      (actor.sensorView?.environmentalHolograms ?? []).map((hologram) => [hologram.id, hologram]),
    ),
  );
const immutableProjection = ({ state: _, ...hologram }: ReturnType<typeof withoutTransition>) =>
  hologram;

export function validateEnvironmentalHolograms(
  context: ReplayContext,
  prior: ReplayCheckpoint,
  state: { actors: ActorDisplay[] },
  record: StreamRecord,
) {
  const required = record.kind === 'initial' ? record.requiredFeatures : prior.requiredFeatures;
  const before = hologramMap(prior.state?.actors ?? []);
  const after = hologramMap(state.actors);
  const all = state.actors.flatMap((actor) => actor.sensorView?.environmentalHolograms ?? []);
  requireReplay(after.size === all.length, 'duplicate environmental hologram');
  const enabled = required?.includes('environmental-holograms-v1') === true;
  requireReplay(
    state.actors.every((actor) => (actor.sensorView !== undefined) === enabled),
    'environmental hologram sensor view',
  );
  if (all.length)
    requireReplay(
      required?.includes('environmental-holograms-v1') === true,
      'environmental hologram feature',
    );
  const actorIds = new Set(state.actors.map((actor) => actor.id));
  const step = record.kind === 'interval' ? record.toStep : record.step;
  for (const actor of state.actors)
    for (const hologram of actor.sensorView?.environmentalHolograms ?? [])
      requireReplay(
        hologram.observerId === actor.id &&
          hologram.observerIds.length === 1 &&
          hologram.observerIds[0] === actor.id &&
          hologram.creatorId !== actor.id &&
          actorIds.has(hologram.creatorId) &&
          hologram.activatedAt <= step &&
          step <= hologram.expiresAt,
        'environmental hologram observer/time',
      );
  if (!('events' in record)) return;
  for (const [id, hologram] of after) {
    const old = before.get(id);
    if (!old) {
      const event = record.events.find(
        (candidate) =>
          candidate.environmentalHologram?.id === id &&
          candidate.environmentalHologram.transition === 'activated',
      );
      requireReplay(
        !!event &&
          event.environmentalHologram !== undefined &&
          same(withoutTransition(event.environmentalHologram), hologram) &&
          id ===
            environmentalHologramId(
              context.manifest.seed,
              hologram.creatorId,
              hologram.observerId,
              event.sequence,
            ),
        'environmental hologram activation identity',
      );
      continue;
    }
    requireReplay(
      same(immutableProjection(old), immutableProjection(hologram)),
      'environmental hologram immutable projection',
    );
    if (old.state === hologram.state) continue;
    const transition =
      old.state === 'active-unobserved' && hologram.state === 'observed'
        ? 'observed'
        : old.state === 'observed' && hologram.state === 'invalidated'
          ? 'invalidated'
          : null;
    const transitions = record.events.filter(
      (event) =>
        event.environmentalHologram?.id === id &&
        event.environmentalHologram.transition === transition,
    );
    requireReplay(
      !!transition &&
        transitions.length === 1 &&
        transitions[0]!.environmentalHologram !== undefined &&
        same(withoutTransition(transitions[0]!.environmentalHologram!), hologram),
      'environmental hologram lifecycle transition',
    );
  }
  for (const [id, hologram] of before) {
    if (after.has(id)) continue;
    const terminal = record.events.filter(
      (event) =>
        event.environmentalHologram?.id === id &&
        event.environmentalHologram.transition === 'expired',
    );
    requireReplay(
      terminal.length === 1 &&
        terminal[0]!.environmentalHologram !== undefined &&
        same(withoutTransition(terminal[0]!.environmentalHologram!), hologram),
      'environmental hologram terminal transition',
    );
  }
}
