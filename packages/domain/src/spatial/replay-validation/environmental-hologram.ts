import {
  environmentalHologramBinding,
  environmentalHologramId,
  environmentalHologramOrdinal,
} from '../environmental-holograms.ts';
import type { BattleEvent } from '../records.ts';
import type { EnvironmentalHologramProvenance, ReplayCheckpoint } from '../replay.ts';
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
const immutableProjection = (hologram: ReturnType<typeof withoutTransition>) => {
  const { state, observedAt, invalidatedAt, expiresAt, ...projection } = hologram;
  void state;
  void observedAt;
  void invalidatedAt;
  void expiresAt;
  return projection;
};

type EnvironmentalHologram = NonNullable<
  ActorDisplay['sensorView']
>['environmentalHolograms'][number];
type Provenance = EnvironmentalHologramProvenance;

function pausedBefore(
  actor: ActorDisplay,
  hologram: EnvironmentalHologram,
  deadline: number,
  step: number,
) {
  const completed = (actor.clock?.periods ?? []).reduce(
    (total, period) =>
      period.from < deadline
        ? total + Math.max(0, period.to - Math.max(period.from, hologram.activatedAt))
        : total,
    0,
  );
  const active = actor.clock?.frozen;
  return (
    completed +
    (active && active.from < deadline
      ? Math.max(0, step - Math.max(active.from, hologram.activatedAt))
      : 0)
  );
}

function validateProjection(
  context: ReplayContext,
  actor: ActorDisplay,
  hologram: EnvironmentalHologram,
  step: number,
  boundaryApplied: boolean,
) {
  const creator = context.actors.find(
    (candidate) => candidate.participant.actorId === hologram.creatorId,
  );
  const ability = creator?.abilities.find((candidate) => candidate.id === hologram.abilityId);
  const effects =
    hologram.stageIndex === undefined
      ? ability?.definition.effects
      : ability?.definition.stages?.[hologram.stageIndex]?.effects;
  const effect = effects?.[hologram.effectIndex];
  requireReplay(
    effect?.kind === 'environmental-hologram',
    'environmental hologram authored effect',
  );
  if (effect?.kind !== 'environmental-hologram') return;
  const ordinal = environmentalHologramOrdinal(hologram.id);
  requireReplay(
    ordinal !== null &&
      hologram.id ===
        environmentalHologramId(
          context.manifest.seed,
          hologram.creatorId,
          hologram.observerId,
          ordinal,
        ),
    'environmental hologram identity',
  );
  requireReplay(
    same(hologram.perceivedPosition, {
      x: hologram.sourcePosition.x + effect.offsetMm.x / 1000,
      y: hologram.sourcePosition.y + effect.offsetMm.y / 1000,
      z: hologram.sourcePosition.z + effect.offsetMm.z / 1000,
    }),
    'environmental hologram authored position',
  );
  requireReplay(
    hologram.observedAt ===
      hologram.activatedAt +
        effect.observationSteps +
        pausedBefore(actor, hologram, hologram.observedAt, step) &&
      hologram.invalidatedAt ===
        hologram.activatedAt +
          effect.invalidationSteps +
          pausedBefore(actor, hologram, hologram.invalidatedAt, step) &&
      hologram.expiresAt ===
        hologram.activatedAt +
          effect.durationSteps +
          pausedBefore(actor, hologram, hologram.expiresAt, step),
    'environmental hologram authored schedule',
  );
  const lifecycleStep = actor.clock?.frozen?.from ?? step;
  const lifecycleBoundaryApplied = actor.clock?.frozen ? true : boundaryApplied;
  const after = (deadline: number) =>
    lifecycleStep > deadline || (lifecycleStep === deadline && lifecycleBoundaryApplied);
  requireReplay(
    hologram.state ===
      (after(hologram.invalidatedAt)
        ? 'invalidated'
        : after(hologram.observedAt)
          ? 'observed'
          : 'active-unobserved'),
    'environmental hologram checkpoint lifecycle',
  );
}

export function validateEnvironmentalHologramCheckpoint(
  context: ReplayContext,
  state: { actors: ActorDisplay[] },
  step: number,
  boundaryApplied: boolean,
  requiredFeatures: readonly string[] | undefined,
  provenance?: readonly Provenance[],
) {
  const enabled = requiredFeatures?.includes('environmental-holograms-v1') === true;
  const all = state.actors.flatMap((actor) => actor.sensorView?.environmentalHolograms ?? []);
  requireReplay(
    state.actors.every((actor) => (actor.sensorView !== undefined) === enabled),
    'environmental hologram sensor view',
  );
  requireReplay(
    new Set(all.map((hologram) => hologram.id)).size === all.length,
    'duplicate environmental hologram',
  );
  const actorIds = new Set(state.actors.map((actor) => actor.id));
  if (provenance) {
    requireReplay(
      provenance.length === all.length &&
        new Set(provenance.map((entry) => entry.id)).size === provenance.length,
      'environmental hologram checkpoint provenance',
    );
    for (const hologram of all) {
      const proof = provenance.find((entry) => entry.id === hologram.id);
      requireReplay(
        !!proof &&
          proof.creatorId === hologram.creatorId &&
          proof.observerId === hologram.observerId &&
          proof.abilityId === hologram.abilityId &&
          proof.effectIndex === hologram.effectIndex &&
          proof.stageIndex === hologram.stageIndex &&
          same(proof.sourcePosition, hologram.sourcePosition) &&
          hologram.id ===
            environmentalHologramId(
              context.manifest.seed,
              hologram.creatorId,
              hologram.observerId,
              proof.activationSequence,
            ) &&
          proof.binding === environmentalHologramBinding(context.simulationHash, proof),
        'environmental hologram checkpoint provenance binding',
      );
    }
  }
  for (const actor of state.actors)
    for (const hologram of actor.sensorView?.environmentalHolograms ?? []) {
      requireReplay(
        hologram.observerId === actor.id &&
          hologram.observerIds.length === 1 &&
          hologram.observerIds[0] === actor.id &&
          hologram.creatorId !== actor.id &&
          actorIds.has(hologram.creatorId) &&
          hologram.activatedAt <= step &&
          (step < hologram.expiresAt || (step === hologram.expiresAt && !boundaryApplied)),
        'environmental hologram observer/time',
      );
      validateProjection(context, actor, hologram, step, boundaryApplied);
    }
}

export function advanceEnvironmentalHologramProvenance(
  simulationHash: string,
  previous: readonly Provenance[] | undefined,
  record: StreamRecord,
) {
  if (!('events' in record)) return previous ? [...previous] : undefined;
  const retained = new Map((previous ?? []).map((entry) => [entry.id, entry]));
  for (const event of record.events) {
    const hologram = event.environmentalHologram;
    if (!hologram) continue;
    if (hologram.transition === 'activated') {
      const proof = {
        id: hologram.id,
        creatorId: hologram.creatorId,
        observerId: hologram.observerId,
        abilityId: hologram.abilityId,
        effectIndex: hologram.effectIndex,
        ...(hologram.stageIndex === undefined ? {} : { stageIndex: hologram.stageIndex }),
        sourcePosition: { ...hologram.sourcePosition },
        activationSequence: event.sequence,
      };
      retained.set(hologram.id, {
        ...proof,
        binding: environmentalHologramBinding(simulationHash, proof),
      });
    } else if (hologram.transition === 'expired') retained.delete(hologram.id);
  }
  return retained.size ? [...retained.values()] : undefined;
}

export function validateEnvironmentalHolograms(
  context: ReplayContext,
  prior: ReplayCheckpoint,
  state: { actors: ActorDisplay[] },
  record: StreamRecord,
) {
  const required = record.kind === 'initial' ? record.requiredFeatures : prior.requiredFeatures;
  const before = hologramMap(prior.state?.actors ?? []);
  const after = hologramMap(state.actors);
  const step = record.kind === 'interval' ? record.toStep : record.step;
  const boundaryApplied =
    record.kind === 'boundary' ? true : record.kind === 'terminal' ? prior.boundaryApplied : false;
  validateEnvironmentalHologramCheckpoint(context, state, step, boundaryApplied, required);
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
          event.abilityId === hologram.abilityId &&
          same(event.point, hologram.sourcePosition) &&
          (hologram.stageIndex === undefined
            ? event.stage === undefined
            : event.stage?.stageIndex === hologram.stageIndex) &&
          id ===
            environmentalHologramId(
              context.manifest.seed,
              hologram.creatorId,
              hologram.observerId,
              event.sequence,
            ),
        'environmental hologram activation identity',
      );
      const source = event?.deferrals?.length
        ? prior.deferred?.find((receipt) => event.deferrals!.includes(receipt.id))?.sourcePosition
        : prior.state?.actors.find((candidate) => candidate.id === hologram.creatorId)?.position;
      requireReplay(
        !!source && same(source, hologram.sourcePosition),
        'environmental hologram runtime source position',
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
