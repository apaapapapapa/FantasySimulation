import { expect, it } from 'vite-plus/test';
import { ReplayState, StreamRecordSchema, replayContext } from '@fantasy/domain/spatial';
import { sampleManifest } from '@fantasy/samples';
import { battleEvents } from '../../test-support/fixtures.ts';
import { environmentalHologramManifest } from '../../test-support/environmental-holograms.ts';
import { prepareBattle } from './prepare.ts';
import { runPreparedBattle } from './run.ts';
import { initialActor } from './sim/combat-state.ts';
import { visualSensorEligibility } from './sim/environmental-holograms.ts';
import { createBattleWorld } from './world/terrain.ts';

it('records one observer sensor projection through runtime, AI and replay without an actor target', async () => {
  const battle = await prepareBattle(await environmentalHologramManifest());
  expect(battle.manifest.schemaVersion).toBe(8);
  const run = await runPreparedBattle(battle);
  expect(battle.actors.every((actor) => actor.character.mentalEligibility === undefined)).toBe(
    true,
  );
  expect(run.records.every((record) => StreamRecordSchema.safeParse(record).success)).toBe(true);
  const initial = run.records[0];
  expect(initial?.kind).toBe('initial');
  if (initial?.kind !== 'initial') throw new Error('Missing initial');
  expect(initial.requiredFeatures).toContain('environmental-holograms-v1');
  expect(
    initial.state.actors.every((actor) => actor.sensorView?.environmentalHolograms.length === 0),
  ).toBe(true);

  const events = battleEvents(run.records);
  expect(events.some((event) => event.kind === 'environmental-hologram')).toBe(true);
  const hologramEvents = events.filter((event) => event.environmentalHologram);
  const firstId = hologramEvents[0]!.environmentalHologram!.id;
  const firstLifecycle = hologramEvents.filter(
    (event) => event.environmentalHologram!.id === firstId,
  );
  expect(firstLifecycle.map((event) => event.environmentalHologram!.transition)).toEqual([
    'activated',
    'observed',
    'invalidated',
    'expired',
  ]);
  const activated = firstLifecycle[0]!.environmentalHologram!;
  expect(activated.observerIds).toEqual([activated.observerId]);
  expect(events.some((event) => event.kind === 'damage')).toBe(false);
  expect(events.every((event) => event.targetId !== activated.id)).toBe(true);
  expect(
    run.records.every(
      (record) =>
        !('paths' in record) || record.paths.every((path) => path.entityId !== activated.id),
    ),
  ).toBe(true);
  expect(
    initial.state.actors.every(
      (actor) => !('environmentalHolograms' in actor) && !('mind' in (actor.sensorView ?? {})),
    ),
  ).toBe(true);

  const sensorDecision = events.find(
    (event) =>
      event.kind === 'decision' &&
      event.actorId === activated.observerId &&
      event.cognition?.kind === 'decision' &&
      event.cognition.sensorGoal?.entityId === activated.id,
  );
  expect(
    sensorDecision?.cognition?.kind === 'decision' ? sensorDecision.cognition.sensorGoal : null,
  ).toEqual({
    entityId: activated.id,
    positionMm: {
      x: Math.round(activated.perceivedPosition.x * 1000),
      y: Math.round(activated.perceivedPosition.y * 1000),
      z: Math.round(activated.perceivedPosition.z * 1000),
    },
  });

  const context = await replayContext(battle.manifest, run.result.simulationHash);
  const replay = new ReplayState(context);
  for (const record of run.records) replay.apply(record);
  expect(
    replay
      .checkpoint()
      .state?.actors.every((actor) => actor.sensorView?.environmentalHolograms.length === 0),
  ).toBe(true);

  const activeIndex = run.records.findIndex(
    (record) =>
      'changes' in record &&
      record.changes.some((actor) => actor.sensorView?.environmentalHolograms.length),
  );
  expect(activeIndex).toBeGreaterThan(0);
  const tampered = structuredClone(run.records);
  const active = tampered[activeIndex]!;
  if (!('changes' in active)) throw new Error('Missing hologram delta');
  const projection = active.changes.find((actor) => actor.sensorView)?.sensorView
    ?.environmentalHolograms[0];
  if (!projection) throw new Error('Missing hologram projection');
  projection.perceivedPosition.x += 1;
  expect(() => {
    const invalid = new ReplayState(context);
    tampered.forEach((record) => invalid.apply(record));
  }).toThrow(/environmental hologram/);
});

it('fails closed when the observer visual sensor is disabled without changing resources or RNG', async () => {
  const battle = await prepareBattle(await environmentalHologramManifest());
  const world = createBattleWorld(battle);
  try {
    const actor = initialActor(world, battle.actors[0]!);
    actor.statuses = [
      {
        startStep: 0,
        endStep: 20,
        stacks: 1,
        causes: ['negative-control'],
        revision: {
          definition: {
            adjustments: [{ target: 'vision', operation: 'multiply', amount: 0 }],
          },
        },
      },
    ] as unknown as typeof actor.statuses;
    const before = {
      resources: structuredClone(actor.vitals.resources),
      random: actor.mind.random,
      decisionRandom: structuredClone(actor.mind.decisionRandom),
      sensors: structuredClone(actor.sensors),
    };
    expect(visualSensorEligibility(actor, 0)).toEqual({
      eligible: false,
      reason: 'visual-sensor-disabled',
    });
    expect({
      resources: actor.vitals.resources,
      random: actor.mind.random,
      decisionRandom: actor.mind.decisionRandom,
      sensors: actor.sensors,
    }).toEqual(before);
  } finally {
    world.free();
  }
});

it('preserves legacy replay bytes by omitting the feature and sensor view', async () => {
  const run = await runPreparedBattle(await prepareBattle(await sampleManifest(1)));
  const initial = run.records[0];
  expect(initial?.kind).toBe('initial');
  if (initial?.kind !== 'initial') throw new Error('Missing initial');
  expect(initial.requiredFeatures).toBeUndefined();
  expect(initial.state.actors.every((actor) => actor.sensorView === undefined)).toBe(true);
});
