import { expect, it } from 'vite-plus/test';
import {
  stoppedTransaction,
  stopClockManifest,
  stopManifest,
} from '../../test-support/time-stop.ts';
import { initialStatus, withInitialStatus } from '../../test-support/ai.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { sealRevision } from './manifest-builder.ts';
import { runBattle } from './run.ts';
import { StepTransaction } from './sim/step-transaction.ts';
import { startPhase } from './sim/phase-start.ts';
import { contactPhase } from './sim/phase-contact.ts';
import { resolutionPhase } from './sim/phase-resolution.ts';
import { boundaryPhase } from './sim/phase-boundary.ts';
import { releaseStop, activateStops } from './sim/time-stop-control.ts';
import { subjectStep, freezeActor } from './rules/subject-clocks.ts';
import { HitLedger } from './rules/hit-ledger.ts';
import { objectAbility } from '../../test-support/object-manifest.ts';
import {
  queueSpatialObject,
  activateSpatialObjects,
  expireSpatialObjects,
} from './sim/spatial-commands.ts';

it.each(['area', 'beam', 'barrier'] as const)(
  'keeps %s object lifetime global while the current owner is frozen',
  async (kind) => {
    const input = await stopManifest({ targetAttack: objectAbility(kind) });
    input.participants[0].position.x = -2000;
    input.participants[1].position.x = 2000;
    const f = await stoppedTransaction(input);
    try {
      const launch = new StepTransaction(f.context, f.previous, 0, 20, 0, 'interval'),
        owner = launch.next.actors[1]!,
        ability = owner.actions.action!.ability;
      queueSpatialObject(
        launch,
        owner,
        ability,
        'e.0',
        {
          actionId: owner.actions.action!.id,
          stageId: 'emit',
          stageIndex: 0,
          emitterId: 0,
          hitGroupId: 'field',
        },
        ability.definition.stages![0]!.hit,
        owner.body.motion.facing,
      );
      const activated = new StepTransaction(f.context, launch.next, 1, 30, 0, 'boundary');
      activateSpatialObjects(activated);
      freezeActor(activated.next.actors[1]!, 't.objects', 1, 20);
      const interval = new StepTransaction(activated.context, activated.next, 3, 40, 0, 'interval');
      startPhase(interval);
      contactPhase(interval);
      expect(interval.effects).toHaveLength(kind === 'area' ? 1 : 0);
      const end = kind === 'area' ? 11 : 4;
      expect(interval.next.objects![0]!.endStep).toBe(end);
      const expiry = new StepTransaction(interval.context, interval.next, end, 50, 0, 'boundary');
      expireSpatialObjects(expiry);
      expect(expiry.next.objects).toEqual([]);
      expect(expiry.next.actors[1]!.clock!.frozen).toBeDefined();
      expiry.discardWorld();
      activated.discardWorld();
    } finally {
      f.world.free();
    }
  },
);

it('resumes a paid cast with exactly its remaining subject duration and no duplicate cost', async () => {
  const input = await stopClockManifest({ castSteps: 10, costs: { hp: 0, mp: 3, uses: 1 } });
  const run = await runBattle(input);
  await recordedCheckpoints(input, run);
  const events = battleEvents(run.records),
    start = events.find((e) => e.actorId === 'right' && e.kind === 'cast-start')!,
    launch = events.find((e) => e.actorId === 'right' && e.kind === 'launch')!;
  expect(launch.step).toBe(start.step + 22);
  expect(events.filter((e) => e.actorId === 'right' && e.kind === 'cost')).toHaveLength(1);
});

it('preserves every remaining attached melee interval through a committed thaw boundary', async () => {
  const attack = {
    kind: 'melee' as const,
    radiusMm: 100,
    reachMm: 2000,
    activeSteps: 10,
    maxHitsPerTarget: 1,
  };
  const effects = [
    {
      kind: 'damage' as const,
      amount: 1,
      attackScaleBps: 0,
      element: 'physical' as const,
      defense: 'none' as const,
    },
  ];
  const input = await stopClockManifest({
    attack,
    rangeMm: 3000,
    effects,
    stages: [
      {
        id: 'held-edge',
        offsetSteps: 0,
        durationSteps: 10,
        attack,
        effects,
        hit: { group: 'edge', maxHits: 10, minIntervalSteps: 1, requireSeparation: false },
      },
    ],
  });
  input.participants[0].position.x = -1000;
  input.participants[1].position.x = 1000;
  const uninterrupted = structuredClone(input);
  await withInitialStatus(uninterrupted, 1, initialStatus({ stopImmunity: true }));
  const control = battleEvents((await runBattle(uninterrupted)).records).filter(
    (event) => event.actorId === 'right' && event.kind === 'hit',
  );
  const run = await runBattle(input);
  await recordedCheckpoints(input, run);
  const events = battleEvents(run.records);
  const launch = events.find((event) => event.actorId === 'right' && event.kind === 'launch')!;
  const stop = events.find((event) => event.timeStop?.state === 'activated')!;
  const release = events.find((event) => event.timeStop?.state === 'release')!;
  const hits = events.filter((event) => event.actorId === 'right' && event.kind === 'hit');
  // An immune control executes the same thrust without the 12 paused intervals.
  expect(control.length).toBeGreaterThan(0);
  expect(hits.map((event) => event.step)).toEqual(control.map((event) => event.step + 12));
  expect(hits.at(-1)!.step).toBe(launch.step + 21);
  expect(hits.some((event) => event.step >= stop.step && event.step < release.step)).toBe(false);
  expect(events.filter((event) => event.actorId === 'right' && event.kind === 'cost')).toHaveLength(
    1,
  );
});

it('holds motion hover costs regeneration and fractional carries while preserving attached contact separation', async () => {
  const f = await stoppedTransaction();
  try {
    const actor = f.tx.next.actors[1]!,
      resolved = actor.body.motion.actor;
    actor.body.motion.actor = {
      ...resolved,
      character: {
        ...resolved.character,
        stamina: { max: 100, recoveryPerSecond: 10, resumeAt: 10 },
      },
    };
    actor.vitals.resources.stamina = 80;
    actor.vitals.staminaClock = { remainder: 900, exhausted: false };
    actor.body.motionClock = { remainder: 700000, flightRemainder: 960000 };
    actor.body.motion.position.y = 5;
    actor.body.motion.velocity = { x: 2, y: 0, z: 0 };
    actor.body.motion.grounded = false;
    actor.body.intent = { ...actor.body.intent, flight: true, direction: { x: 1, y: 0, z: 0 } };
    const wings = await sealRevision(
      'status',
      'stop-wings',
      1,
      initialStatus({
        flightStaminaPerSecond: 25,
        modifiers: { attack: 0, defense: 0, speedBps: 10000, flight: true, rooted: false },
      }),
    );
    actor.statuses = [{ revision: wings, startStep: 0, endStep: 100, stacks: 1, causes: ['e.0'] }];
    const before = structuredClone(actor),
      tx = new StepTransaction(f.context, f.tx.next, 1, 20, 0, 'interval');
    startPhase(tx);
    contactPhase(tx);
    resolutionPhase(tx);
    const after = tx.next.actors[1]!;
    expect(after.body.motion.position).toEqual(before.body.motion.position);
    expect(after.body.motion.velocity).toEqual(before.body.motion.velocity);
    expect(after.vitals).toEqual(before.vitals);
    expect(after.body.motionClock).toEqual(before.body.motionClock);
    expect(
      tx.journal.events.some((e) => e.actorId === 'right' && ['cost', 'resource'].includes(e.kind)),
    ).toBe(false);
    const ledger = new HitLedger(),
      contact = {
        actionId: 'attached',
        stageId: 'edge',
        stageIndex: 0,
        emitterId: 0,
        hitGroupId: 'edge',
      },
      rule = { group: 'edge', maxHits: 3, minIntervalSteps: 1, requireSeparation: true };
    expect(ledger.contact(contact, rule, 'left', subjectStep(after, 1)).accepted).toBe(true);
    releaseStop(tx, 6, 'fixture thaw', 'boundary');
    expect(ledger.contact(contact, rule, 'left', subjectStep(after, 6)).accepted).toBe(false);
    expect(ledger.contact(contact, rule, 'left', subjectStep(after, 7)).reason).toBe(
      'hit-separation',
    );
    expect(ledger.contact(contact, rule, 'left', subjectStep(after, 9)).accepted).toBe(true);
  } finally {
    f.world.free();
  }
});

it('tests effective immunity only at activation and keeps global control through later seal incapacity and dispel', async () => {
  const f = await stoppedTransaction();
  try {
    const active = f.tx.next.stop!.active!,
      ward = await sealRevision('status', 'stop-ward', 1, initialStatus({ stopImmunity: true })),
      seal = await sealRevision(
        'status',
        'stop-ward-seal',
        1,
        initialStatus({ seals: { statusIds: [ward.id] } }),
      ),
      incapacity = await sealRevision(
        'status',
        'stop-incapacity',
        1,
        initialStatus({
          seals: { abilityCategories: ['magic'] },
          adjustments: [{ target: 'action', operation: 'multiply', amount: 0 }],
        }),
      );
    const cohort = (revision: typeof ward) => ({
      revision,
      startStep: 0,
      endStep: 50,
      stacks: 1,
      causes: ['e.0'],
    });
    f.tx.next.actors[1]!.statuses = [cohort(ward)];
    f.tx.next.actors[0]!.statuses = [cohort(incapacity)];
    const next = new StepTransaction(f.context, f.tx.next, 2, 20, 0, 'boundary');
    boundaryPhase(next);
    expect(next.next.stop!.active).toEqual(active);
    // Ordinary status removal cannot delete a global control record.
    next.next.actors.forEach((a) => {
      a.statuses = [];
    });
    const due = new StepTransaction(f.context, next.next, 6, 30, 0, 'boundary');
    boundaryPhase(due);
    expect(due.next.stop!.active).toBeUndefined();
    expect(due.next.actors[1]!.clock!.pausedSteps).toBe(5);
    due.next.actors[1]!.statuses = [cohort(ward), cohort(seal)];
    due.next.stop!.requests.push({ ...active, id: 't.restop', at: 6, duration: 1 });
    activateStops(due);
    expect(due.next.stop!.active?.id).toBe('t.restop');
    expect(subjectStep(due.next.actors[1]!, 6)).toBe(1);
    expect(due.next.stop!.reserved).toBe(6);
  } finally {
    f.world.free();
  }
});
