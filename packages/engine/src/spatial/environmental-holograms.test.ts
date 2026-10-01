import { expect, it } from 'vite-plus/test';
import {
  ReplayState,
  StoredManifestSchema,
  StreamRecordSchema,
  DEFAULT_BUDGET,
  replayContext,
  type StreamRecord,
} from '@fantasy/domain/spatial';
import { sampleManifest } from '@fantasy/samples';
import { battleEvents } from '../../test-support/fixtures.ts';
import { environmentalHologramManifest } from '../../test-support/environmental-holograms.ts';
import { initialStatus, withInitialStatus } from '../../test-support/ai.ts';
import { prepareBattle } from './prepare.ts';
import { runPreparedBattle } from './run.ts';
import { initialActor } from './sim/combat-state.ts';
import {
  settleEnvironmentalHolograms,
  visualSensorEligibility,
} from './sim/environmental-holograms.ts';
import { createBattleWorld } from './world/terrain.ts';
import { freezeActor, rebaseActorTimers } from './rules/subject-clocks.ts';
import { Journal } from './rules/journal.ts';
import { ManifestBuilder, sealRevision } from './manifest-builder.ts';
import { spatialTransaction } from '../../test-support/spatial-objects.ts';
import { stopManifest, stoppedTransaction } from '../../test-support/time-stop.ts';
import { commitEffects } from './sim/combat-effects.ts';
import { releaseStop } from './sim/time-stop-control.ts';

type Hologram = NonNullable<
  StreamRecord extends infer _Record
    ? Extract<StreamRecord, { kind: 'initial' }>['state']['actors'][number]['sensorView']
    : never
>['environmentalHolograms'][number];

function mutateHologramEverywhere(
  records: StreamRecord[],
  id: string,
  mutate: (hologram: Hologram) => void,
) {
  for (const record of records) {
    if ('events' in record)
      for (const event of record.events)
        if (event.environmentalHologram?.id === id) mutate(event.environmentalHologram);
    const actors =
      record.kind === 'initial' ? record.state.actors : 'changes' in record ? record.changes : [];
    for (const actor of actors)
      for (const hologram of actor.sensorView?.environmentalHolograms ?? [])
        if (hologram.id === id) mutate(hologram);
  }
}

function expectReplayRejected(
  context: ConstructorParameters<typeof ReplayState>[0],
  records: StreamRecord[],
) {
  expect(() => {
    const replay = new ReplayState(context);
    records.forEach((record) => replay.apply(record));
  }).toThrow(/[Ee]nvironmental hologram/);
}

function finalResources(records: StreamRecord[]) {
  const initial = records[0];
  if (initial?.kind !== 'initial') throw new Error('Missing initial display');
  const actors = structuredClone(initial.state.actors);
  for (const record of records)
    if ('changes' in record)
      for (const change of record.changes)
        Object.assign(
          actors.find((actor) => actor.id === change.id)!,
          change,
        );
  return actors.map((actor) => actor.resources);
}

const decisionTrace = (records: StreamRecord[]) =>
  battleEvents(records).flatMap((event) =>
    event.cognition?.kind === 'decision'
      ? [
          {
            actorId: event.actorId,
            step: event.step,
            candidates: event.cognition.candidates,
            selection: event.cognition.selection,
            draws: event.cognition.draws,
          },
        ]
      : [],
  );

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
  const invalidatedAt = firstLifecycle[2]!.step;
  const expiredAt = firstLifecycle[3]!.step;
  const decisionsAfterInvalidation = events.filter(
    (event) =>
      event.kind === 'decision' &&
      event.actorId === activated.observerId &&
      event.step >= invalidatedAt &&
      event.step < expiredAt &&
      event.cognition?.kind === 'decision',
  );
  expect(decisionsAfterInvalidation.length).toBeGreaterThan(0);
  expect(
    decisionsAfterInvalidation.every(
      (event) => event.cognition?.kind === 'decision' && event.cognition.sensorGoal === undefined,
    ),
  ).toBe(true);
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
  expectReplayRejected(context, tampered);

  const coordinated = structuredClone(run.records);
  mutateHologramEverywhere(coordinated, firstId, (hologram) => {
    hologram.sourcePosition.x += 1;
    hologram.perceivedPosition.x += 1;
  });
  for (const record of coordinated)
    if ('events' in record)
      for (const event of record.events)
        if (event.environmentalHologram?.id === firstId && event.point) event.point.x += 1;
  expect(() => {
    const invalid = new ReplayState(context);
    coordinated.forEach((record) => invalid.apply(record));
  }).toThrow(/environmental hologram runtime source position/);

  const identityTampered = structuredClone(run.records);
  mutateHologramEverywhere(identityTampered, firstId, (hologram) => {
    hologram.id = `${hologram.id.slice(0, -1)}0`;
  });
  for (const record of identityTampered)
    if ('events' in record)
      for (const event of record.events)
        if (event.entityId === firstId) event.entityId = `${firstId.slice(0, -1)}0`;
  expectReplayRejected(context, identityTampered);

  const observerTampered = structuredClone(run.records);
  mutateHologramEverywhere(observerTampered, firstId, (hologram) => {
    hologram.observerId = hologram.creatorId;
    hologram.observerIds = [hologram.creatorId];
  });
  for (const record of observerTampered)
    if ('events' in record)
      for (const event of record.events)
        if (event.environmentalHologram?.id === firstId)
          event.targetId = event.environmentalHologram.observerId;
  expectReplayRejected(context, observerTampered);

  const lifecycleTampered = structuredClone(run.records);
  mutateHologramEverywhere(lifecycleTampered, firstId, (hologram) => {
    hologram.observedAt += 1;
    hologram.invalidatedAt += 1;
    hologram.expiresAt += 1;
  });
  expectReplayRejected(context, lifecycleTampered);

  const orderTampered = structuredClone(run.records);
  const activation = orderTampered
    .flatMap((record) => ('events' in record ? record.events : []))
    .find((event) => event.environmentalHologram?.id === firstId);
  if (!activation?.environmentalHologram) throw new Error('Missing activation event');
  activation.environmentalHologram.transition = 'observed';
  expectReplayRejected(context, orderTampered);

  const activeReplay = new ReplayState(context);
  for (const record of run.records.slice(0, activeIndex + 1)) activeReplay.apply(record);
  const checkpoint = activeReplay.checkpoint();
  const checkpointProjection = checkpoint.state?.actors
    .flatMap((actor) => actor.sensorView?.environmentalHolograms ?? [])
    .find((hologram) => hologram.id === firstId);
  if (!checkpointProjection) throw new Error('Missing checkpoint projection');
  checkpointProjection.perceivedPosition.x += 1;
  expect(() => new ReplayState(context, checkpoint)).toThrow(
    /environmental hologram authored position/,
  );

  const checkpointLifecycle = activeReplay.checkpoint();
  const lifecycleProjection = checkpointLifecycle.state?.actors
    .flatMap((actor) => actor.sensorView?.environmentalHolograms ?? [])
    .find((hologram) => hologram.id === firstId);
  if (!lifecycleProjection) throw new Error('Missing lifecycle projection');
  lifecycleProjection.state = 'invalidated';
  expect(() => new ReplayState(context, checkpointLifecycle)).toThrow(
    /environmental hologram checkpoint lifecycle/,
  );
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

it('fizzles an actual no-visual projection without changing AI choice, RNG, or resources', async () => {
  const attempted = await environmentalHologramManifest();
  const oldAbility = attempted.revisions.find(
    (revision) => revision.kind === 'ability' && revision.id === 'sk07-hologram',
  );
  if (!oldAbility || oldAbility.kind !== 'ability') throw new Error('Missing hologram ability');
  const noEffect = await sealRevision('ability', oldAbility.id, oldAbility.revision, {
    ...oldAbility.definition,
    effects: [
      {
        kind: 'damage',
        amount: 0,
        attackScaleBps: 0,
        element: 'physical',
        defense: 'none',
      },
    ],
  });
  const control = await ManifestBuilder.relink(attempted, [{ from: oldAbility, to: noEffect }]);
  const blind = initialStatus({
    adjustments: [{ target: 'vision', operation: 'multiply', amount: 0 }],
  });
  for (const index of [0, 1] as const) {
    await withInitialStatus(attempted, index, blind);
    await withInitialStatus(control, index, blind);
  }
  const fixture = await spatialTransaction({ manifest: attempted });
  try {
    const source = fixture.tx.next.actors.find(
      (actor) => actor.body.motion.actor.participant.actorId === 'left',
    )!;
    const observer = fixture.tx.next.actors.find(
      (actor) => actor.body.motion.actor.participant.actorId === 'right',
    )!;
    const blindRevision = fixture.battle.statuses.find(
      (revision) => revision.id === 'initial-status-1',
    )!;
    observer.statuses.push({
      revision: blindRevision,
      startStep: 0,
      endStep: 200,
      stacks: 1,
      causes: ['fixture'],
    });
    const ability = source.body.motion.actor.abilities.find(
      (candidate) => candidate.id === 'sk07-hologram',
    )!;
    const before = fixture.tx.next.actors.map((actor) => ({
      resources: structuredClone(actor.vitals.resources),
      random: actor.mind.random,
      decisionRandom: structuredClone(actor.mind.decisionRandom),
      sensors: structuredClone(actor.sensors),
    }));
    commitEffects(
      fixture.tx.next.actors,
      [
        {
          actorId: 'left',
          targetId: 'right',
          abilityId: ability.id,
          effectIndex: 0,
          parentEventId: 'e.0',
          attack: 0,
          effect: ability.definition.effects[0]!,
        },
      ],
      {
        ...fixture.context,
        journal: fixture.tx.journal,
        step: 1,
        activationStep: 1,
        phase: 'boundary',
      },
    );
    expect(fixture.tx.journal.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'fizzle',
          abilityId: 'sk07-hologram',
          reason: 'visual-sensor-disabled',
        }),
      ]),
    );
    expect(
      fixture.tx.next.actors.map((actor) => ({
        resources: actor.vitals.resources,
        random: actor.mind.random,
        decisionRandom: actor.mind.decisionRandom,
        sensors: actor.sensors,
      })),
    ).toEqual(before);
  } finally {
    fixture.world.free();
  }
  const attemptedRun = await runPreparedBattle(await prepareBattle(attempted));
  const controlRun = await runPreparedBattle(await prepareBattle(control));
  expect(battleEvents(attemptedRun.records).some((event) => event.environmentalHologram)).toBe(
    false,
  );
  expect(decisionTrace(attemptedRun.records)).toEqual(decisionTrace(controlRun.records));
  expect(finalResources(attemptedRun.records)).toEqual(finalResources(controlRun.records));
});

it('pauses only future observer lifecycle deadlines on its subject clock', async () => {
  const battle = await prepareBattle(await environmentalHologramManifest());
  const world = createBattleWorld(battle);
  try {
    const actor = initialActor(world, battle.actors[0]!);
    const projection = {
      id: 'hologram.1.1.1',
      creatorId: 'right',
      observerId: 'left',
      observerIds: ['left'] as [string],
      abilityId: 'sk07-hologram',
      effectIndex: 0,
      modality: 'visual' as const,
      sourcePosition: { x: 0, y: 0, z: 0 },
      perceivedPosition: { x: 12, y: 0, z: 4 },
      state: 'active-unobserved' as const,
      activatedAt: 1,
      observedAt: 4,
      invalidatedAt: 8,
      expiresAt: 12,
    };
    actor.sensors.environmentalHolograms = [
      structuredClone(projection),
      { ...structuredClone(projection), id: 'hologram.1.2.2', state: 'observed', observedAt: 3 },
      {
        ...structuredClone(projection),
        id: 'hologram.1.3.3',
        state: 'invalidated',
        observedAt: 2,
        invalidatedAt: 3,
      },
    ];
    freezeActor(actor, 't.hologram', 4, 9);
    const journal = new Journal(0, 0, DEFAULT_BUDGET);
    settleEnvironmentalHolograms(actor, 9, journal);
    expect(journal.events).toEqual([]);
    expect(actor.sensors.environmentalHolograms.map((hologram) => hologram.state)).toEqual([
      'active-unobserved',
      'observed',
      'invalidated',
    ]);
    rebaseActorTimers(actor, 5, 4);
    expect(
      actor.sensors.environmentalHolograms.map(
        ({ activatedAt, observedAt, invalidatedAt, expiresAt }) => ({
          activatedAt,
          observedAt,
          invalidatedAt,
          expiresAt,
        }),
      ),
    ).toEqual([
      { activatedAt: 1, observedAt: 9, invalidatedAt: 13, expiresAt: 17 },
      { activatedAt: 1, observedAt: 3, invalidatedAt: 13, expiresAt: 17 },
      { activatedAt: 1, observedAt: 2, invalidatedAt: 3, expiresAt: 17 },
    ]);
  } finally {
    world.free();
  }
});

it('retains the authored contact source through time-stop deferral', async () => {
  const effect = {
    kind: 'environmental-hologram' as const,
    modality: 'visual' as const,
    offsetMm: { x: 12_000, y: 0, z: 4_000 },
    observationSteps: 2,
    invalidationSteps: 7,
    durationSteps: 10,
  };
  let manifest = await stopManifest({ sourceAttack: { effects: [effect] } });
  const oldRules = manifest.revisions.find(
    (revision) => revision.kind === 'ruleset' && revision.id === manifest.ruleset.id,
  );
  if (!oldRules || oldRules.kind !== 'ruleset') throw new Error('Missing rules');
  const rules = await sealRevision('ruleset', oldRules.id, oldRules.revision, {
    ...oldRules.definition,
    experimental: {
      mechanics: [...oldRules.definition.experimental!.mechanics, 'visibility'],
    },
  });
  manifest = await ManifestBuilder.relink({ ...manifest, schemaVersion: 8 }, [
    { from: oldRules, to: rules },
  ]);
  const fixture = await stoppedTransaction(manifest);
  try {
    const [source, observer] = fixture.tx.next.actors;
    const captured = fixture.hooks.capture!([
      {
        actorId: 'left',
        targetId: 'right',
        abilityId: 'stop-shot-0',
        effectIndex: 0,
        parentEventId: 'e.0',
        attack: 0,
        effect,
        observation: { self: source!.body.motion, target: observer!.body.motion },
      },
    ]);
    expect(captured).toEqual([]);
    const receipt = fixture.tx.journal.events.flatMap(
      (event) => event.timeStop?.captured ?? [],
    )[0]!;
    expect(receipt.sourcePosition).toEqual(source!.body.motion.position);
    source!.body.motion.position.x += 30;
    const released = releaseStop(fixture.tx, 2, 'fixture release', 'resolution');
    commitEffects(fixture.tx.next.actors, released, fixture.effectContext);
    const activated = fixture.tx.journal.events.find(
      (event) => event.environmentalHologram?.transition === 'activated',
    );
    expect(activated?.deferrals).toEqual([receipt.id]);
    expect(activated?.point).toEqual(receipt.sourcePosition);
    expect(activated?.environmentalHologram?.sourcePosition).toEqual(receipt.sourcePosition);
  } finally {
    fixture.world.free();
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

it('admits legacy schemas 3 through 7 but requires schema 8 for holograms', async () => {
  const legacy = await sampleManifest(1);
  for (const schemaVersion of [3, 4, 5, 6, 7] as const)
    expect(StoredManifestSchema.safeParse({ ...legacy, schemaVersion }).success).toBe(true);
  const hologram = await environmentalHologramManifest();
  expect(StoredManifestSchema.safeParse(hologram).success).toBe(true);
  expect(StoredManifestSchema.safeParse({ ...hologram, schemaVersion: 7 }).success).toBe(false);
});
