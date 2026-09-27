import { expect, it } from 'vite-plus/test';
import {
  stoppedTransaction,
  stopManifest,
  stopDamage,
  withStopReactions,
} from '../../test-support/time-stop.ts';
import { reviveAbility } from '../../test-support/revival.ts';
import { commitReactiveEffects } from './sim/reactions.ts';
import { releaseStop } from './sim/time-stop-control.ts';
import { commitEffects } from './sim/combat-effects.ts';

it.each([false, true])(
  'releases at a newly lethal reaction cost without retroactive before-hit and then revives=%s',
  async (revive) => {
    let input = await withStopReactions(await stopManifest(), 0, [
      {
        trigger: 'after-damage',
        costs: { hp: 39, mp: 0, uses: 1 },
        reaction: { response: { kind: 'effects' } },
        effects: [{ kind: 'shield', amount: 1 }],
      },
      ...(revive ? [reviveAbility({ costs: { hp: 0, mp: 0, uses: 1 } })] : []),
    ]);
    input = await withStopReactions(input, 1, [
      { reaction: { response: { kind: 'parry', scope: 'all' } }, costs: { hp: 0, mp: 3, uses: 1 } },
      {
        trigger: 'after-damage',
        reaction: { response: { kind: 'effects' } },
        costs: { hp: 0, mp: 2, uses: 1 },
        effects: [{ kind: 'shield', amount: 3 }],
      },
    ]);
    const f = await stoppedTransaction(input);
    try {
      f.hooks.capture!([stopDamage('left', 'right', 20, 10000)]);
      const work = f.context.work.candidates;
      commitReactiveEffects(
        f.tx.next.actors,
        [stopDamage('right', 'left', 1)],
        f.effectContext,
        f.context.work.reactions,
      );
      expect(f.tx.next.actors.map((actor) => actor.vitals.resources.hp)).toEqual([
        revive ? 7 : 0,
        20,
      ]);
      expect(f.tx.next.actors[1]!.vitals.resources).toMatchObject({ mp: 25, shield: 3 });
      expect(
        f.tx.journal.events.filter((event) => event.timeStop?.state === 'release'),
      ).toHaveLength(1);
      expect(f.tx.journal.events.filter((event) => event.damage)).toHaveLength(2);
      expect(f.tx.journal.events.filter((event) => event.revival)).toHaveLength(Number(revive));
      expect(f.context.work.candidates).toBeGreaterThan(work);
      expect(f.tx.next.actors[1]!.actions.used['stop-1-reaction-0']).toBeUndefined();
      expect(f.tx.next.actors[1]!.actions.used['stop-1-reaction-1']).toBe(1);
    } finally {
      f.world.free();
    }
  },
);

it('uses one opening shield and preserves captured force direction visibility and power after relocation', async () => {
  const f = await stoppedTransaction();
  try {
    const [left, right] = f.tx.next.actors;
    const observation = { self: left!.body.motion, target: right!.body.motion };
    f.hooks.capture!([
      { ...stopDamage('left', 'right', 10), observation },
      { ...stopDamage('left', 'right', 10), observation },
      {
        ...stopDamage('left', 'right', 0),
        observation,
        effect: {
          kind: 'force',
          profile: 'linear-v1',
          direction: 'away',
          speedMmPerSecond: 1000,
          durationSteps: 3,
        },
      },
    ]);
    left!.body.motion.position = { x: 30, y: 1, z: 0 };
    right!.body.motion.position = { x: -30, y: 1, z: 0 };
    right!.vitals.resources.shield = 7;
    const released = releaseStop(f.tx, 2, 'fixture teleport', 'resolution');
    expect(released.every((effect) => effect.capturedVisible === true)).toBe(true);
    commitEffects(f.tx.next.actors, released, f.effectContext);
    expect(right!.vitals.resources).toMatchObject({ hp: 27, shield: 0 });
    expect(right!.body.forces![0]).toMatchObject({
      startAt: 2,
      endAt: 5,
      velocityMmPerSecond: { x: 1000, y: 0, z: 0 },
    });
    expect(
      f.tx.journal.events
        .filter((event) => event.damage)
        .map((event) => [event.before!.hp, event.after!.hp]),
    ).toEqual([
      [40, 27],
      [40, 27],
    ]);
  } finally {
    f.world.free();
  }
});
