import { expect, it } from 'vite-plus/test';
import {
  ReplayState,
  ReplayManifestSchema,
  RECORDING_PROFILE,
  StoredManifestSchema,
  StreamRecordSchema,
  DEFAULT_BUDGET,
  replayContext,
  seekReplayState,
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
  message: RegExp = /[Ee]nvironmental hologram/,
) {
  expect(() => {
    const replay = new ReplayState(context);
    records.forEach((record) => replay.apply(record));
  }).toThrow(message);
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
            candidates: event.cognition.candidates.map((value) => {
              const { reason, ...candidate } = value;
              void reason;
              return candidate;
            }),
            selection: event.cognition.selection,
            draws: event.cognition.draws,
          },
        ]
      : [],
  );

async function enableVisibility(manifest: Awaited<ReturnType<typeof stopManifest>>) {
  const oldRules = manifest.revisions.find(
    (revision) => revision.kind === 'ruleset' && revision.id === manifest.ruleset.id,
  );
  if (!oldRules || oldRules.kind !== 'ruleset') throw new Error('Missing rules');
  const rules = await sealRevision('ruleset', oldRules.id, oldRules.revision, {
    ...oldRules.definition,
    experimental: {
      mechanics: [...oldRules.definition.experimental!.mechanics, 'visibility' as const].sort(),
    },
  });
  return {
    manifest: await ManifestBuilder.relink({ ...manifest, schemaVersion: 8 }, [
      { from: oldRules, to: rules },
    ]),
    relink: { from: oldRules, to: rules },
  };
}

async function environmentalStopManifest(hologramFirst: boolean) {
  const effect = {
    kind: 'environmental-hologram' as const,
    modality: 'visual' as const,
    offsetMm: { x: 12_000, y: 0, z: 4_000 },
    observationSteps: 2,
    invalidationSteps: 7,
    durationSteps: 15,
  };
  let manifest = await stopManifest({
    duration: hologramFirst ? 5 : 50,
    steps: hologramFirst ? 40 : 80,
    sourceAttack: {
      effects: [effect],
      costs: { hp: 0, mp: 0, uses: 1 },
      cooldownSteps: 100,
    },
  });
  const visibility = await enableVisibility(manifest);
  const changes: Parameters<typeof ManifestBuilder.relink>[1][number][] = [visibility.relink];
  if (hologramFirst) {
    const oldPolicy = manifest.revisions.find(
      (revision) => revision.kind === 'policy' && revision.id === 'stop-policy-0',
    );
    if (!oldPolicy || oldPolicy.kind !== 'policy') throw new Error('Missing source policy');
    const policy = await sealRevision('policy', oldPolicy.id, oldPolicy.revision, {
      ...oldPolicy.definition,
      priorities: [...oldPolicy.definition.priorities].reverse(),
    });
    changes.push({ from: oldPolicy, to: policy });
  }
  return ManifestBuilder.relink(visibility.manifest, changes.slice(1));
}

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
  const checkpoints = [new ReplayState(context).checkpoint(), activeReplay.checkpoint()];
  const starts = [0, activeIndex + 1];
  const ends = [activeIndex + 1, run.records.length];
  const replayManifest = ReplayManifestSchema.parse({
    schemaVersion: 1,
    id: 'environmental-hologram-seek',
    resultId: 'result-1',
    attemptId: 'attempt-1',
    simulationHash: run.result.simulationHash,
    input: battle.manifest,
    profile: RECORDING_PROFILE,
    lastVerifiedStep: run.result.steps,
    records: run.records.length,
    eventHash: run.result.eventHash,
    trajectoryHash: run.result.trajectoryHash,
    end: { kind: 'result', result: run.result },
    checkpoints: starts.map((start, index) => ({
      file: `checkpoint-${String(index).padStart(5, '0')}.json.gz`,
      bytes: 1,
      rawBytes: 1,
      checksum: run.result.eventHash,
      index,
      step: checkpoints[index]!.step,
      nextRecord: start,
    })),
    chunks: starts.map((start, index) => ({
      file: `chunk-${String(index).padStart(5, '0')}.ndjson.gz`,
      bytes: 1,
      rawBytes: 1,
      checksum: run.result.eventHash,
      index,
      firstRecord: start,
      records: ends[index]! - start,
      fromStep: checkpoints[index]!.step,
      toStep: index === 0 ? activeReplay.step : replay.step,
      checkpoint: index,
    })),
  });
  const seekSource = (activeCheckpoint = activeReplay.checkpoint()) => ({
    checkpoint: (index: number) => Promise.resolve(index === 0 ? checkpoints[0] : activeCheckpoint),
    records: (index: number) => Promise.resolve(run.records.slice(starts[index], ends[index])),
  });
  expect(
    (await seekReplayState(context, replayManifest, activeIndex + 1, seekSource())).checkpoint(),
  ).toEqual(activeReplay.checkpoint());
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
        kind: 'sensory-cue',
        modality: 'visual',
        offsetMm: { x: 12_000, y: 0, z: 4_000 },
        deliverySteps: 2,
        discoverySteps: 6,
        durationSteps: 10,
        confidenceBps: 10_000,
      },
    ],
  });
  let control = await ManifestBuilder.relink(attempted, [{ from: oldAbility, to: noEffect }]);
  const controlRules = control.revisions.find(
    (revision) => revision.kind === 'ruleset' && revision.id === control.ruleset.id,
  );
  if (!controlRules || controlRules.kind !== 'ruleset') throw new Error('Missing control rules');
  const mindReadRules = await sealRevision('ruleset', controlRules.id, controlRules.revision, {
    ...controlRules.definition,
    experimental: {
      mechanics: [...controlRules.definition.experimental!.mechanics, 'mind-read' as const].sort(),
    },
  });
  control = await ManifestBuilder.relink(control, [{ from: controlRules, to: mindReadRules }]);
  const blind = initialStatus({
    adjustments: [{ target: 'vision', operation: 'multiply', amount: 0 }],
  });
  await withInitialStatus(attempted, 1, blind);
  await withInitialStatus(control, 1, blind);
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
  expect(
    battleEvents(attemptedRun.records).some(
      (event) =>
        event.kind === 'fizzle' &&
        event.abilityId === 'sk07-hologram' &&
        event.reason === 'visual-sensor-disabled',
    ),
  ).toBe(true);
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
  const { manifest } = await enableVisibility(
    await stopManifest({ sourceAttack: { effects: [effect] } }),
  );
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

it('rejects coordinated capture receipt and deferred projection geometry tampering', async () => {
  const battle = await prepareBattle(await environmentalStopManifest(false));
  const run = await runPreparedBattle(battle);
  const context = await replayContext(battle.manifest, run.result.simulationHash);
  const replay = new ReplayState(context);
  run.records.forEach((record) => replay.apply(record));
  const events = battleEvents(run.records);
  const receipt = events
    .flatMap((event) => event.timeStop?.captured ?? [])
    .find((candidate) => candidate.effect.kind === 'environmental-hologram');
  const activated = events.find(
    (event) => receipt && event.deferrals?.includes(receipt.id) && event.environmentalHologram,
  );
  expect(receipt?.sourcePosition).toEqual(activated?.environmentalHologram?.sourcePosition);
  if (!receipt || !activated?.environmentalHologram) throw new Error('Missing deferred hologram');
  const tampered = structuredClone(run.records);
  for (const record of tampered)
    if ('events' in record)
      for (const event of record.events) {
        const captured = event.timeStop?.captured?.find((candidate) => candidate.id === receipt.id);
        if (captured?.sourcePosition) captured.sourcePosition.x += 1;
        if (event.environmentalHologram?.id === activated.environmentalHologram!.id && event.point)
          event.point.x += 1;
      }
  mutateHologramEverywhere(tampered, activated.environmentalHologram.id, (hologram) => {
    hologram.sourcePosition.x += 1;
    hologram.perceivedPosition.x += 1;
  });
  expectReplayRejected(context, tampered);
});

it('replays actual freeze, thaw and future-only observer lifecycle deadlines', async () => {
  const battle = await prepareBattle(await environmentalStopManifest(true));
  const run = await runPreparedBattle(battle);
  const events = battleEvents(run.records);
  const lifecycle = events.filter((event) => event.environmentalHologram);
  const activated = lifecycle.find(
    (event) => event.environmentalHologram?.transition === 'activated',
  );
  if (!activated?.environmentalHologram) throw new Error('Missing lifecycle activation');
  const ownLifecycle = lifecycle.filter(
    (event) => event.environmentalHologram?.id === activated.environmentalHologram!.id,
  );
  expect(ownLifecycle.map((event) => event.environmentalHologram!.transition)).toEqual([
    'activated',
    'observed',
    'invalidated',
    'expired',
  ]);
  const stopped = events.find(
    (event) =>
      event.timeStop?.state === 'activated' &&
      event.targetId === activated.environmentalHologram!.observerId,
  );
  const released = events.find(
    (event) =>
      event.timeStop?.state === 'release' &&
      event.timeStop.controlId === stopped?.timeStop?.controlId,
  );
  if (!stopped || !released) throw new Error('Missing observer freeze');
  const pause = released.step - stopped.step;
  const base = activated.step;
  const shifted = (deadline: number) => deadline + Number(stopped.step < deadline) * pause;
  expect(ownLifecycle.slice(1).map((event) => event.step)).toEqual([
    shifted(base + 2),
    shifted(base + 7),
    shifted(base + 15),
  ]);
  const context = await replayContext(battle.manifest, run.result.simulationHash);
  const replay = new ReplayState(context);
  run.records.forEach((record) => replay.apply(record));
  const observer = replay
    .checkpoint()
    .state?.actors.find((actor) => actor.id === activated.environmentalHologram!.observerId);
  expect(observer?.clock?.periods).toContainEqual({ from: stopped.step, to: released.step });
  expect(observer?.sensorView?.environmentalHolograms).toEqual([]);

  const deadlineTampered = structuredClone(run.records);
  mutateHologramEverywhere(deadlineTampered, activated.environmentalHologram.id, (hologram) => {
    hologram.invalidatedAt += 1;
    hologram.expiresAt += 1;
  });
  expectReplayRejected(context, deadlineTampered);

  const clockTampered = structuredClone(run.records);
  const clock = clockTampered
    .flatMap((record) => ('changes' in record ? record.changes : []))
    .find(
      (actor) =>
        actor.id === activated.environmentalHologram!.observerId &&
        (actor.clock?.periods?.length ?? 0) > 0,
    )?.clock;
  const period = clock?.periods?.[0];
  if (!period) throw new Error('Missing completed observer clock period');
  period.to += 1;
  expectReplayRejected(context, clockTampered, /Invalid replay/);

  const coordinatedClockTampered = structuredClone(run.records);
  for (const record of coordinatedClockTampered) {
    const recordStep = record.kind === 'interval' ? record.toStep : record.step;
    if ('changes' in record)
      for (const actor of record.changes) {
        if (actor.id !== activated.environmentalHologram.observerId) continue;
        if (actor.clock?.periods?.[0]) actor.clock.periods[0].to += 1;
        if (recordStep < released.step) continue;
        for (const hologram of actor.sensorView?.environmentalHolograms ?? [])
          if (hologram.id === activated.environmentalHologram.id) {
            hologram.invalidatedAt += 1;
            hologram.expiresAt += 1;
          }
      }
    if ('events' in record && recordStep >= released.step)
      for (const event of record.events)
        if (event.environmentalHologram?.id === activated.environmentalHologram.id) {
          event.environmentalHologram.invalidatedAt += 1;
          event.environmentalHologram.expiresAt += 1;
        }
  }
  expectReplayRejected(context, coordinatedClockTampered, /Invalid replay/);
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
