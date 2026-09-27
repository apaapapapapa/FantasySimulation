import { expect, it } from 'vite-plus/test';
import { ReplayState } from '@fantasy/domain/spatial';
import {
  stoppedTransaction,
  stopClockManifest,
  stopManifest,
} from '../../test-support/time-stop.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { withInitialStatus, initialStatus } from '../../test-support/ai.ts';
import { runBattle } from './run.ts';
import { clockDisplay, freezeActor, thawActor } from './rules/subject-clocks.ts';
import { releaseStop, activateStops } from './sim/time-stop-control.ts';
import { StepTransaction } from './sim/step-transaction.ts';
import { sealRevision, ManifestBuilder } from './manifest-builder.ts';

it('binds every force deadline to a recorded pending or active force', async () => {
  const input = await stopManifest({
    duration: 12,
    steps: 45,
    sourceAttack: {
      costs: { hp: 0, mp: 0, uses: 1 },
      effects: [
        { kind: 'damage', amount: 1, attackScaleBps: 0, element: 'physical', defense: 'none' },
        {
          kind: 'force',
          profile: 'linear-v1',
          direction: 'away',
          speedMmPerSecond: 1000,
          durationSteps: 20,
        },
      ],
    },
    targetAttack: { costs: { hp: 0, mp: 1000, uses: 1 } },
  });
  const run = await runBattle(input);
  const { context, checkpoints } = await recordedCheckpoints(input, run);
  const saved = checkpoints.find((checkpoint) =>
    checkpoint.state!.actors.some((actor) =>
      actor.clock?.deadlines.some((d) => d.key === 'force.0.end'),
    ),
  )!;
  expect(saved).toBeDefined();
  for (const variant of ['missing', 'unbound', 'altered', 'duration'] as const) {
    const corrupt = structuredClone(saved);
    const actor = corrupt.state!.actors.find((actor) => actor.clock)!;
    const clock = actor.clock!;
    const force = clock.deadlines.find((d) => d.key === 'force.0.end')!;
    if (variant === 'missing') clock.deadlines = clock.deadlines.filter((d) => d !== force);
    if (variant === 'unbound') clock.deadlines.push({ ...force, key: 'force.63.end' });
    if (variant === 'altered' || variant === 'duration') {
      force.at++;
      force.projectedStep++;
      force.remainingSteps++;
    }
    if (variant === 'duration') actor.forceSchedule![0]!.endAt++;
    expect(() => new ReplayState(context, corrupt)).toThrow(/force|deadline/);
  }
});

it('retains recipient deadlines and historical stamps across forty frozen global intervals', async () => {
  const f = await stoppedTransaction();
  try {
    const actor = f.tx.next.actors[0]!;
    freezeActor(actor, 't.clock', 60, 100);
    actor.actions.action = null;
    thawActor(actor, 100);
    actor.actions.action = {
      id: 'clock.action',
      ability: actor.body.motion.actor.abilities[0]!,
      cause: 'e.0',
      startedAt: 100,
      launchAt: 110,
      recoveryUntil: 115,
      released: false,
    };
    actor.statuses = [
      {
        revision: await sealRevision(
          'status',
          'clock-grant',
          1,
          initialStatus({ durationSteps: 10 }),
        ),
        startStep: 100,
        endStep: 110,
        stacks: 1,
        causes: ['e.grant'],
      },
    ];
    expect(clockDisplay(actor, 100)).toMatchObject({
      subjectStep: 60,
      pausedSteps: 40,
      deadlines: [
        { key: 'action.launch', at: 70, remainingSteps: 10, projectedStep: 110 },
        { key: 'action.recovery', at: 75, remainingSteps: 15, projectedStep: 115 },
        { key: 'status.0.end', at: 70, remainingSteps: 10, projectedStep: 110 },
      ],
    });
    freezeActor(actor, 't.clock2', 100, 105);
    expect(clockDisplay(actor, 103)).toMatchObject({
      subjectStep: 60,
      pausedSteps: 43,
      deadlines: [
        { key: 'action.launch', at: 70, remainingSteps: 10, projectedStep: 113 },
        { key: 'action.recovery', at: 75, remainingSteps: 15, projectedStep: 118 },
        { key: 'status.0.end', at: 70, remainingSteps: 10, projectedStep: 113 },
      ],
    });
    expect(actor.actions.action.startedAt).toBe(100);
    expect(actor.actions.action.launchAt).toBe(110);
    expect(actor.statuses[0]!.endStep).toBe(110);
    thawActor(actor, 105);
    expect(actor.actions.action).toMatchObject({
      globalStartedAt: 100,
      startedAt: 105,
      launchAt: 115,
      recoveryUntil: 120,
    });
    expect(clockDisplay(actor, 105)!.subjectStep).toBe(60);
    expect(actor.statuses[0]).toMatchObject({ globalStartStep: 100, startStep: 105, endStep: 115 });
  } finally {
    f.world.free();
  }
});

it('pauses status pulses and delayed readings without catch-up or live resampling', async () => {
  const input = await stopClockManifest({
    effects: [
      {
        kind: 'reveal',
        field: 'health',
        precisionBps: 1000,
        powerBps: 10000,
        durationSteps: 20,
        delaySteps: 3,
        occlusion: 'vision',
      },
    ],
  });
  await withInitialStatus(
    input,
    1,
    initialStatus({
      durationSteps: 30,
      periodic: [{ kind: 'resource', resource: 'mp', amount: 1, everySteps: 2 }],
    }),
  );
  const run = await runBattle(input),
    { checkpoints } = await recordedCheckpoints(input, run);
  const events = battleEvents(run.records),
    activated = events.find((e) => e.timeStop?.state === 'activated')!;
  const released = events.find((e) => e.timeStop?.state === 'release')!;
  const frozen = checkpoints.filter((c) => c.state!.actors[1]!.clock?.frozen);
  expect(released.step - activated.step).toBe(12);
  expect(new Set(frozen.map((c) => c.state!.actors[1]!.resources.mp)).size).toBe(1);
  expect(
    events.filter(
      (e) =>
        e.actorId === 'right' && e.cognition && e.step >= activated.step && e.step < released.step,
    ),
  ).toEqual([]);
  const readings = events.flatMap((e) =>
    e.actorId === 'right' && e.cognition?.kind === 'knowledge' ? (e.cognition.readings ?? []) : [],
  );
  expect(readings).toHaveLength(1);
  expect(readings[0]).toMatchObject({
    availableAt: readings[0]!.sampledAt + 20,
    expiresAt: readings[0]!.sampledAt + 32,
    range: { low: 10000, high: 10000 },
  });
  const statusEnd = frozen.at(-1)!.state!.actors[1]!.statuses[0]!.endStep;
  expect(statusEnd).toBe(42);
});

it('records slow action deadlines beyond the battle horizon without extending global time', async () => {
  const input = await stopClockManifest({
    castSteps: 6000,
    recoverySteps: 6000,
    effects: [
      { kind: 'damage', amount: 1000000, attackScaleBps: 0, element: 'physical', defense: 'none' },
    ],
  });
  const character = input.revisions.find(
    (r) => r.kind === 'character' && r.id === input.participants[1].character.id,
  )!;
  if (character.kind !== 'character') throw new Error('Slow actor fixture');
  const replacement = await ManifestBuilder.create('character', character.id, 1, {
    ...character.definition,
    stats: { ...character.definition.stats, actionSpeedBps: 5000 },
  });
  const slow = await ManifestBuilder.relink(input, [{ from: character, to: replacement }]);
  const run = await runBattle(slow);
  const { checkpoints } = await recordedCheckpoints(slow, run);
  const actor = checkpoints.at(-1)!.state!.actors[1]!;
  expect(checkpoints.at(-1)!.step).toBe(45);
  expect(actor.clock!.pausedSteps).toBe(12);
  expect(actor.action).toMatchObject({ launchAt: 12017, recoveryUntil: 24018, phase: 'cast' });
  expect(actor.clock!.deadlines).toContainEqual({
    key: 'action.recovery',
    domain: 'action',
    at: 24006,
    remainingSteps: 23973,
    projectedStep: 24018,
  });
});

it('holds a current-owner projectile position velocity homing and age, then resumes remaining life', async () => {
  const input = await stopClockManifest({
    attack: {
      kind: 'projectile',
      speedMmPerSecond: 1000,
      radiusMm: 50,
      lifetimeSteps: 20,
      gravityScaleBps: 0,
      homingTurnMilliDegreesPerSecond: 360000,
      observation: 'owner-visible',
      explosionRadiusMm: 0,
      maxHitsPerTarget: 1,
    },
  });
  const run = await runBattle(input),
    { context, checkpoints } = await recordedCheckpoints(input, run);
  const paused = checkpoints
    .filter((c) => c.lastRecord?.kind === 'interval' && c.state!.actors[1]!.clock?.frozen)
    .map((c) => c.state!.projectiles.find((p) => p.ownerId === 'right')!);
  expect(paused).toHaveLength(12);
  expect(paused.every((p) => p !== undefined)).toBe(true);
  expect(
    new Set(paused.map((p) => JSON.stringify([p.position, p.velocity, p.clock!.subjectStep]))).size,
  ).toBe(1);
  const removal = battleEvents(run.records).find(
    (e) => e.ruleId === 'projectile.expired' && e.actorId === 'right',
  )!;
  expect(removal.step).toBe(paused[0]!.launchStep + 31);
  const corrupt = structuredClone(run.records);
  const interval = corrupt.find(
    (record) => record.kind === 'interval' && record.projectiles.update.some((p) => p.clock),
  );
  if (interval?.kind !== 'interval') throw new Error('Frozen projectile fixture');
  interval.projectiles.update.find((p) => p.clock)!.velocity.x++;
  const replay = new ReplayState(context);
  expect(() => corrupt.forEach((record) => replay.apply(record))).toThrow(
    'frozen projectile motion',
  );
});

it('reserves full durations without refund, rejects nesting and stops at four uses or 300 intervals', async () => {
  for (const duration of [1, 100]) {
    const f = await stoppedTransaction();
    try {
      const first = f.tx.next.stop!.active!,
        ability = first.ability;
      // The initial five-interval reservation is retained after early release.
      releaseStop(f.tx, 1, 'early fixture', 'boundary');
      let previous = f.tx.next;
      for (let i = 0; i < 4; i++) {
        const tx = new StepTransaction(f.context, previous, 1, 30 + i * 3, 0, 'boundary');
        tx.next.stop!.requests.push({ ...first, id: `t.repeat${i}`, at: 1, duration });
        activateStops(tx);
        const expected = duration === 1 ? i < 3 : i < 2;
        expect(!!tx.next.stop!.active).toBe(expected);
        if (expected) {
          tx.next.stop!.requests.push({ ...first, id: `t.nested${i}`, at: 1, duration });
          activateStops(tx);
          expect(tx.next.stop!.active!.id).toBe(`t.repeat${i}`);
          releaseStop(tx, 1, 'no elapsed intervals', 'boundary');
        }
        previous = tx.next;
      }
      expect(previous.stop).toMatchObject(
        duration === 1
          ? { uses: 4, reserved: 8, executed: 0 }
          : { uses: 3, reserved: 205, executed: 0 },
      );
      expect(ability.definition.timeStop).toBeDefined();
    } finally {
      f.world.free();
    }
  }
});
