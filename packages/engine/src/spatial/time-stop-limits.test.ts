import { expect, it } from 'vite-plus/test';
import { canonicalJson, ReplayState, DEFAULT_BUDGET } from '@fantasy/domain/spatial';
import { stoppedTransaction, stopDamage, stopManifest } from '../../test-support/time-stop.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { runBattle } from './run.ts';
import { releaseStop, activateStops } from './sim/time-stop-control.ts';
import { StepTransaction } from './sim/step-transaction.ts';
import { stopEffectHooks } from './sim/time-stop-effects.ts';
import { battleEvents } from '../../test-support/fixtures.ts';

it('rolls back a failed release transaction to the committed frozen queue and retries unchanged', async () => {
  const input = await stopManifest({ duration: 12, steps: 25 }),
    complete = await runBattle(input),
    release = battleEvents(complete.records).find((e) => e.timeStop?.state === 'release')!;
  const failed = await runBattle(input, { ...DEFAULT_BUDGET, maxEvents: release.sequence + 1 });
  expect(failed.result.outcome).toMatchObject({ kind: 'truncated', resource: 'events' });
  const { replay } = await recordedCheckpoints(input, failed),
    partial = replay.checkpoint();
  expect(partial.deferred!.length).toBeGreaterThan(0);
  expect(partial.state!.actors[1]!).toMatchObject({
    resources: { hp: 40 },
    clock: { frozen: { until: release.step } },
  });
  expect(battleEvents(failed.records).some((e) => e.timeStop?.state === 'release')).toBe(false);
  expect(failed.records.slice(0, -1)).toEqual(complete.records.slice(0, failed.records.length - 1));
  expect((await runBattle(input)).result).toEqual(complete.result);
  const f = await stoppedTransaction();
  try {
    f.hooks.capture!([stopDamage('left', 'right', 4)]);
    const committed = f.tx.next,
      before = JSON.stringify(committed),
      history = committed.ledger.snapshot(),
      attempted = new StepTransaction(
        { ...f.context, budget: { ...f.context.budget, maxEvents: 0 } },
        committed,
        6,
        20,
        0,
        'boundary',
      ),
      work = f.context.work.candidates;
    const hooks = stopEffectHooks(attempted, {
      ...f.base,
      journal: attempted.journal,
      step: 6,
      activationStep: 6,
      phase: 'boundary',
    });
    expect(() => hooks.beforeCommit!([stopDamage('right', 'left', 100)])).toThrow('events');
    attempted.discardWorld();
    expect(JSON.stringify(committed)).toBe(before);
    expect(committed.ledger.snapshot()).toEqual(history);
    expect(f.context.work.candidates).toBe(work + 1);
  } finally {
    f.world.free();
  }
});

it.each([65536, 65537])(
  'preflights exactly %i canonical UTF-8 bytes before any capture mutation',
  async (bytes) => {
    const f = await stoppedTransaction();
    try {
      // Independently authored descriptor inventory: 46,246 base bytes, two 17-byte
      // fields per template, and 10,586 ID bytes. Only the first ID differs at +1.
      const effects = Array.from({ length: 256 }, (_, i) => ({
        ...stopDamage('left', 'right', 1),
        parentEventId: `e.${i}`,
        dealtBps: 10000,
        powerBps: 10000,
        abilityId:
          'stop-shot-0' + 'x'.repeat(41 + Number(i < 90) + Number(bytes === 65537 && i === 0)),
      }));
      const before = JSON.stringify(f.tx.next),
        eventCount = f.tx.journal.events.length;
      if (bytes === 65536) {
        f.hooks.capture!(effects);
        expect(f.tx.next.stop).toMatchObject({ bytes: 65536, contacts: 256, operations: 256 });
      } else {
        expect(() => f.hooks.capture!(effects)).toThrow('stop-bytes');
        expect(JSON.stringify(f.tx.next)).toBe(before);
        expect(f.tx.journal.events).toHaveLength(eventCount);
      }
    } finally {
      f.world.free();
    }
  },
);

it.each(['contacts', 'operations'] as const)(
  'accepts the exact cumulative %s cap and rolls back the next simultaneous set',
  async (resource) => {
    const f = await stoppedTransaction();
    try {
      const count = resource === 'contacts' ? 256 : 4096;
      const effects = Array.from({ length: count }, (_, i) => ({
        ...stopDamage('left', 'right', 1),
        parentEventId: resource === 'contacts' ? `e.${i}` : 'e.1',
      }));
      f.hooks.capture!(effects);
      expect(f.tx.next.stop![resource]).toBe(count);
      const before = JSON.stringify(f.tx.next),
        events = canonicalJson(f.tx.journal.events);
      expect(() =>
        f.hooks.capture!([{ ...stopDamage('left', 'right', 1), parentEventId: 'e.9000' }]),
      ).toThrow(`stop-${resource}`);
      expect(JSON.stringify(f.tx.next)).toBe(before);
      expect(canonicalJson(f.tx.journal.events)).toBe(events);
      const stop = f.tx.next.stop!;
      expect(stop.bytes).toBe(
        new TextEncoder().encode(
          canonicalJson({
            templates: stop.templates,
            payloads: stop.payloads,
            descriptors: stop.descriptors,
          }),
        ).length,
      );
    } finally {
      f.world.free();
    }
  },
);

it('keeps cumulative captures after release and rejects 200 released plus 100 new contacts atomically', async () => {
  const f = await stoppedTransaction();
  try {
    const contacts = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...stopDamage('left', 'right', 1),
        parentEventId: `e.${i}`,
      }));
    f.hooks.capture!(contacts(200));
    expect(releaseStop(f.tx, 2, 'fixture early release', 'resolution')).toHaveLength(200);
    expect(f.tx.next.stop!.pending).toEqual([]);
    const control = f.tx.journal.events.find((event) => event.timeStop?.state === 'activated')!;
    const ability = f.tx.next.actors[0]!.body.motion.actor.abilities.find(
      (a) => a.id === control.abilityId,
    )!;
    const tx = new StepTransaction(f.context, f.tx.next, 2, 20, 0, 'boundary');
    tx.next.stop!.requests.push({
      id: 't.second',
      ownerId: 'left',
      targetId: 'right',
      ability,
      cause: 'e.0',
      at: 2,
      duration: 5,
    });
    activateStops(tx);
    const hooks = stopEffectHooks(tx, {
      ...f.base,
      journal: tx.journal,
      step: 2,
      activationStep: 2,
      phase: 'boundary',
    });
    const before = JSON.stringify(tx.next);
    expect(() => hooks.capture!(contacts(100))).toThrow('stop-contacts');
    expect(JSON.stringify(tx.next)).toBe(before);
    expect(tx.next.stop).toMatchObject({
      contacts: 200,
      operations: 200,
      reserved: 10,
      executed: 1,
    });
  } finally {
    f.world.free();
  }
});

it('rejects missing checkpoint descriptors, feature declarations, duplicate settlement and control releases', async () => {
  const input = await stopManifest({ duration: 12, steps: 25 }),
    run = await runBattle(input);
  const { context, checkpoints } = await recordedCheckpoints(input, run);
  const pending = checkpoints.find((checkpoint) => checkpoint.deferred?.length)!;
  for (const variant of [
    'descriptor',
    'clock',
    'features',
    'ledger',
    'domain',
    'binding',
  ] as const) {
    const corrupt = structuredClone(pending);
    if (variant === 'descriptor') corrupt.deferred!.pop();
    if (variant === 'clock') delete corrupt.state!.actors.find((actor) => actor.clock)!.clock;
    if (variant === 'features') delete corrupt.requiredFeatures;
    if (variant === 'ledger') delete corrupt.stop;
    if (variant === 'domain')
      corrupt.state!.actors.find((actor) => actor.clock)!.clock!.deadlines[0]!.domain =
        'projectile';
    if (variant === 'binding')
      corrupt.state!.actors.find((actor) => actor.clock)!.clock!.deadlines[0]!.key = 'unknown.end';
    expect(() => new ReplayState(context, corrupt)).toThrow(/checkpoint|clock|descriptor|deadline/);
  }
  const completed = checkpoints.find((checkpoint) =>
    checkpoint.state!.actors.some(
      (actor) => !actor.action && actor.clock?.deadlines.some((d) => d.key === 'action.recovery'),
    ),
  )!;
  for (const variant of ['future', 'missing'] as const) {
    const corrupt = structuredClone(completed);
    const clock = corrupt.state!.actors.find((actor) => actor.clock)!.clock!;
    if (variant === 'missing')
      clock.deadlines = clock.deadlines.filter((d) => d.key !== 'action.launch');
    else {
      const recovery = clock.deadlines.find((d) => d.key === 'action.recovery')!;
      recovery.at = clock.subjectStep + 1;
      recovery.projectedStep = recovery.at + clock.pausedSteps;
      recovery.remainingSteps = 1;
    }
    expect(() => new ReplayState(context, corrupt)).toThrow('completed action deadlines');
  }
  for (const variant of ['features', 'settlement', 'release'] as const) {
    const records = structuredClone(run.records);
    if (variant === 'features') {
      const initial = records[0]!;
      if (initial.kind === 'initial') delete initial.requiredFeatures;
    } else {
      const event = records
        .flatMap((record) => ('events' in record ? record.events : []))
        .find((event) =>
          variant === 'settlement' ? event.deferrals?.length : event.timeStop?.state === 'release',
        )!;
      if (variant === 'settlement') event.deferrals!.push(event.deferrals![0]!);
      else event.timeStop!.controlId = 't.unknown';
    }
    const replay = new ReplayState(context);
    expect(() => records.forEach((record) => replay.apply(record))).toThrow(
      /feature|deferred|stop|clock/,
    );
  }
});
