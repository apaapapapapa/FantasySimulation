import type { ReplayContext } from './context.ts';
import type {
  SpatialObjectDisplay,
  SpatialObjectChanges,
  DisplayState,
  StreamRecord,
} from '../stream.ts';
import type { ReplayCheckpoint } from '../replay.ts';
import { requireReplay, same } from './common.ts';

export function validateSpatialObject(
  context: ReplayContext,
  object: SpatialObjectDisplay,
  step: number,
) {
  const owner = context.actors.find((a) => a.participant.actorId === object.ownerId),
    ability = owner?.abilities.find((a) => a.id === object.abilityId)?.definition;
  requireReplay(!!ability, 'spatial object ability/owner');
  const stage = object.stage && ability!.stages?.[object.stage.stageIndex];
  if (object.stage)
    requireReplay(
      !!stage &&
        stage.id === object.stage.stageId &&
        object.stage.emitterId === 0 &&
        object.stage.hitGroupId === (stage.hit?.group ?? 'shared'),
      'spatial object stage',
    );
  const plan = stage || ability!,
    attack = plan.attack;
  const spec =
    object.kind === 'barrier' ? plan.barrier : attack?.kind === object.kind ? attack : null;
  requireReplay(
    !!spec && object.activeFrom <= step && step <= object.endStep,
    'spatial object definition/window',
  );
  const from = object.launchStep + (object.kind === 'beam' ? 0 : 1);
  const duration =
    object.kind === 'beam'
      ? stage?.durationSteps
      : spec && 'durationSteps' in spec
        ? spec.durationSteps
        : undefined;
  requireReplay(
    object.activeFrom === from && object.endStep === from + (duration ?? 0),
    'spatial object lifetime',
  );
  if (object.kind === 'barrier') {
    const barrier = plan.barrier!;
    requireReplay(
      same(object.shape, barrier.shape) &&
        same(object.blocks, barrier.blocks) &&
        object.maxDurability === barrier.durability &&
        object.attachment === barrier.attachment,
      'barrier display binding',
    );
  } else if (object.kind === 'area')
    requireReplay(
      attack?.kind === 'area' && same(object.shape, attack.shape) && object.attachment === 'fixed',
      'area display binding',
    );
  else {
    requireReplay(
      attack?.kind === 'beam' && object.radiusMm === attack.radiusMm && !!object.stage,
      'beam display binding',
    );
    const d = object.direction!;
    requireReplay(
      Math.abs(Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z) - 1) < 1e-6,
      'beam direction',
    );
    if (object.geometry) {
      const geometry = object.geometry;
      requireReplay(
        geometry.kind === 'ray' && geometry.radiusMm === object.radiusMm,
        'beam geometry shape',
      );
      if (geometry.kind === 'ray')
        for (const [i, s] of geometry.segments.entries())
          requireReplay(
            s.from === s.to &&
              (i === 0 || s.from > geometry.segments[i - 1]!.from) &&
              Math.sqrt(
                (s.end.x - s.start.x) ** 2 +
                  (s.end.y - s.start.y) ** 2 +
                  (s.end.z - s.start.z) ** 2,
              ) <=
                ability!.rangeMm / 1000 + 1e-5,
            'beam clipped geometry',
          );
    }
  }
  const scenario = context.manifest.revisions.find(
    (r) => r.kind === 'scenario' && r.id === context.manifest.scenario.id,
  );
  requireReplay(scenario?.kind === 'scenario', 'spatial object scenario');
  if (scenario?.kind !== 'scenario') return;
  const bounds = scenario.definition.bounds;
  for (const k of ['x', 'y', 'z'] as const)
    requireReplay(
      object.position[k] >= bounds.min[k] / 1000 && object.position[k] <= bounds.max[k] / 1000,
      'spatial object bounds',
    );
}
export function applySpatialObjects(
  context: ReplayContext,
  prior: ReplayCheckpoint,
  state: DisplayState,
  changes: SpatialObjectChanges,
  record: Extract<StreamRecord, { kind: 'boundary' | 'interval' }>,
  entities: Set<string>,
) {
  const objects = state.objects ?? [],
    touched = new Set<string>(),
    step = record.kind === 'boundary' ? record.step : record.toStep;
  for (const object of changes.spawn) {
    requireReplay(!entities.has(object.id), 'duplicate object spawn');
    const launchEvents = [
      ...(prior.lastRecord && 'events' in prior.lastRecord ? prior.lastRecord.events : []),
      ...record.events,
    ];
    const launch = launchEvents.find((e) => e.id === object.cause);
    requireReplay(
      launch?.kind === 'launch' &&
        launch.actorId === object.ownerId &&
        launch.abilityId === object.abilityId &&
        launch.step === object.launchStep,
      'spatial object launch cause',
    );
    requireReplay(
      object.activeFrom === (record.kind === 'boundary' ? step : record.fromStep) &&
        (object.kind === 'beam') === (record.kind === 'interval'),
      'spatial object spawn phase',
    );
    validateSpatialObject(context, object, step);
    entities.add(object.id);
    touched.add(object.id);
    objects.push(object);
  }
  for (const object of changes.update) {
    const index = objects.findIndex((o) => o.id === object.id),
      old = objects[index];
    requireReplay(!!old && !touched.has(object.id), 'spatial object update');
    const { position: _p, geometry: _g, durability: _d, ...identity } = object;
    const { position: _op, geometry: _og, durability: _od, ...oldIdentity } = old!;
    requireReplay(
      same(identity, oldIdentity) &&
        (object.attachment !== 'fixed' || same(object.position, old!.position)) &&
        (object.durability === undefined || object.durability <= old!.durability!),
      'spatial object immutable source/pose',
    );
    validateSpatialObject(context, object, step);
    touched.add(object.id);
    objects[index] = object;
  }
  for (const removal of changes.remove) {
    const index = objects.findIndex((o) => o.id === removal.id),
      object = objects[index];
    requireReplay(
      !!object && !touched.has(removal.id) && record.kind === 'boundary',
      'spatial object removal',
    );
    requireReplay(
      removal.reason !== 'expired' || object!.endStep === step,
      'spatial object expiry',
    );
    requireReplay(
      removal.reason !== 'broken' || object!.durability === 0,
      'spatial object breakage',
    );
    touched.add(removal.id);
    objects.splice(index, 1);
  }
  requireReplay(objects.length <= 256, 'spatial object count');
  state.objects = objects;
}
