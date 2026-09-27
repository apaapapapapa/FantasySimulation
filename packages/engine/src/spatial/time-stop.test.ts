import { expect, it } from 'vite-plus/test';
import { AbilitySchema, ReplayState } from '@fantasy/domain/spatial';
import { stopManifest, stoppedTransaction, stopDamage } from '../../test-support/time-stop.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { recordedCheckpoints, runReversedEnumeration } from '../../test-support/replay.ts';
import { initialStatus, withInitialStatus } from '../../test-support/ai.ts';
import { runBattle } from './run.ts';
import { commitReactiveEffects } from './sim/reactions.ts';
import { ManifestBuilder } from './manifest-builder.ts';

it.each([
  [500, 20250, true],
  [-500, 19750, false],
])('rechecks stop range from muzzle %i at distance %i', async (muzzle, distance, accepted) => {
  let input = await stopManifest();
  input.participants[0].position.x = 0;
  input.participants[1].position.x = distance;
  for (const index of [0, 1] as const) {
    const from = input.revisions.find(
      (r) => r.kind === 'character' && r.id === input.participants[index].character.id,
    )!;
    if (from.kind !== 'character') throw new Error('Range participant');
    const to = await ManifestBuilder.create('character', from.id, 1, {
      ...from.definition,
      body: {
        ...from.definition.body,
        muzzleOffset: { x: index === 0 ? muzzle : 0, y: 0, z: 0 },
        aimOffset: { x: 0, y: 0, z: 0 },
      },
    });
    input = await ManifestBuilder.relink(input, [{ from, to }]);
  }
  const f = await stoppedTransaction(input);
  try {
    expect(!!f.tx.next.stop!.active).toBe(accepted);
    expect(!!f.tx.next.actors[1]!.clock?.frozen).toBe(accepted);
  } finally {
    f.world.free();
  }
  if (accepted) {
    const run = await runBattle(input);
    await recordedCheckpoints(input, run);
    expect(battleEvents(run.records).some((e) => e.timeStop?.state === 'activated')).toBe(true);
  }
});

it.each([1, 12])(
  'freezes exactly %i intervals and settles captured hits once at thaw',
  async (duration) => {
    const input = await stopManifest({ duration, steps: 25 });
    const run = await runBattle(input);
    const { replay, checkpoints } = await recordedCheckpoints(input, run);
    const events = battleEvents(run.records),
      activated = events.find((event) => event.timeStop?.state === 'activated')!;
    const released = events.find((event) => event.timeStop?.state === 'release')!;
    expect(released.step - activated.step).toBe(duration);
    expect(released.timeStop).toMatchObject({
      uses: 1,
      reservedSteps: duration,
      executedSteps: duration,
    });
    const frozen = checkpoints.filter(
      (checkpoint) =>
        checkpoint.lastRecord?.kind === 'interval' && checkpoint.state!.actors[1]!.clock?.frozen,
    );
    expect(frozen).toHaveLength(duration);
    expect(
      new Set(frozen.map((checkpoint) => checkpoint.state!.actors[1]!.clock!.subjectStep)).size,
    ).toBe(1);
    const captured = events.filter((event) => event.timeStop?.state === 'capture');
    expect(captured.length > 0).toBe(duration === 12);
    const thawHits = events.filter(
      (event) => event.damage && event.targetId === 'right' && event.step === released.step,
    );
    expect(thawHits).toHaveLength(released.timeStop!.operations);
    expect(
      thawHits.every(
        (event) => event.before!.hp === 40 && event.after!.hp === 40 - 4 * thawHits.length,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.damage &&
          event.targetId === 'right' &&
          event.step > activated.step &&
          event.step < released.step,
      ),
    ).toBe(false);
    expect(replay.checkpoint().step).toBe(25);
    const reversed = await runReversedEnumeration(input);
    expect(reversed.records).toEqual(run.records);
  },
);

it('rejects two individually valid opposing stops without a priority winner', async () => {
  const input = await stopManifest({ both: true });
  const run = await runBattle(input);
  await recordedCheckpoints(input, run);
  const controls = battleEvents(run.records).filter((event) => event.timeStop);
  expect(controls.filter((event) => event.timeStop!.state === 'activated')).toHaveLength(0);
  expect(controls.filter((event) => event.timeStop!.state === 'fizzle')).toHaveLength(2);
  expect(
    controls.every((event) => event.timeStop!.uses === 0 && event.timeStop!.reservedSteps === 0),
  ).toBe(true);
});

it('an immune invalid stop cannot cancel the other valid opposing request', async () => {
  const input = await stopManifest({ both: true });
  await withInitialStatus(input, 0, initialStatus({ stopImmunity: true }));
  const run = await runBattle(input);
  await recordedCheckpoints(input, run);
  expect(
    battleEvents(run.records)
      .filter((event) => event.timeStop?.state === 'activated')
      .map((event) => event.actorId),
  ).toEqual(['left']);
});

it('performs one release-only transaction at the global time limit and validates clock corruption', async () => {
  const input = await stopManifest({ duration: 100, steps: 20 });
  const run = await runBattle(input);
  const { context, replay } = await recordedCheckpoints(input, run);
  const release = battleEvents(run.records).find((event) => event.timeStop?.state === 'release')!;
  expect(release.step).toBe(20);
  expect(release.reason).toContain('release-only');
  expect(replay.checkpoint().state!.actors[1]!.clock!.frozen).toBeUndefined();
  expect(run.records.filter((record) => record.kind === 'interval')).toHaveLength(20);
  expect(run.records.at(-2)).toMatchObject({ kind: 'boundary', step: 20 });
  const corrupt = structuredClone(run.records);
  const record = corrupt.find(
    (record) => record.kind === 'interval' && record.changes.some((delta) => delta.clock),
  )!;
  if (record.kind !== 'interval') throw new Error('Missing clock');
  record.changes.find((delta) => delta.clock)!.clock!.subjectStep++;
  const bad = new ReplayState(context);
  expect(() => corrupt.forEach((value) => bad.apply(value))).toThrow(/clock/);
});

it('probes prospective defeat before committing and combines buffered drain in the same opening wave', async () => {
  const fixture = await stoppedTransaction();
  try {
    const { tx, hooks, effectContext: context } = fixture,
      right = tx.next.actors[1]!;
    expect(hooks.capture!([stopDamage('left', 'right', 20, 10000)])).toEqual([]);
    expect(right.vitals.resources.hp).toBe(40);
    commitReactiveEffects(
      tx.next.actors,
      [stopDamage('right', 'left', 50)],
      context,
      fixture.context.work.reactions,
    );
    expect(tx.next.actors.map((actor) => actor.vitals.resources.hp)).toEqual([10, 20]);
    expect(tx.next.stop!.active).toBeUndefined();
    expect(tx.journal.events.filter((event) => event.damage)).toHaveLength(2);
    expect(tx.journal.events.filter((event) => event.ruleId === 'damage.drain')).toHaveLength(1);
    expect(tx.journal.events.filter((event) => event.timeStop?.state === 'release')).toHaveLength(
      1,
    );
  } finally {
    fixture.world.free();
  }
});

it('rejects arbitrary masks, startup stop and unbounded durations', async () => {
  const input = await stopManifest();
  const ability = input.revisions.find(
    (revision) => revision.kind === 'ability' && revision.definition.timeStop,
  )!;
  for (const edit of [
    { timeStop: { durationSteps: 101 } },
    { timeStop: { durationSteps: 5, clocks: ['global'] } },
    { trigger: 'battle-start' },
    { accuracy: 'no-error' },
  ])
    expect(AbilitySchema.safeParse({ ...ability.definition, ...edit }).success).toBe(false);
});

it('completes a same-boundary paid teleport before rechecking the queued stop range', async () => {
  const input = await stopManifest({
    sourceAttack: { costs: { hp: 0, mp: 1000, uses: 1 } },
    targetAttack: {
      target: 'self',
      attack: { kind: 'direct' },
      effects: [],
      castSteps: 5,
      rangeMm: 0,
      costs: { hp: 0, mp: 3, uses: 1 },
      relocation: { anchor: 'self', direction: 'back', distanceMm: 20000, maxDistanceMm: 20000 },
    },
  });
  const run = await runBattle(input);
  await recordedCheckpoints(input, run);
  const events = battleEvents(run.records),
    teleport = events.find((event) => event.teleport)!;
  const fizzle = events.find((event) => event.timeStop?.state === 'fizzle')!;
  expect(teleport.step).toBe(6);
  expect(fizzle.step).toBe(teleport.step);
  expect(events.filter((event) => event.timeStop?.state === 'activated')).toEqual([]);
  expect(fizzle.timeStop).toMatchObject({ uses: 0, reservedSteps: 0 });
});
