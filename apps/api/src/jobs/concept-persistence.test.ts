import { expect, it } from 'vite-plus/test';
import { conceptManifest } from '../../../../packages/engine/test-support/concepts.ts';
import { stopManifest } from '../../../../packages/engine/test-support/time-stop.ts';
import { withRuntime, runPersistedBattle } from '../../test-support/runtime.ts';
import { seekReplay, verifyReplay } from '../replay/replay-reader.ts';

it('preserves defeat and cumulative immortal protection across Worker SQLite rewind and seek', async () => {
  await withRuntime(
    async ({ runtime, store, jobs, root }) => {
      const input = await conceptManifest({
        both: true,
        status: { immortality: { protections: 1 } },
      });
      const { done, saved, direct } = await runPersistedBattle(
        { runtime, store, jobs },
        input,
        'p6-concepts',
      );
      expect(done.state).toBe('completed');
      expect(JSON.parse(saved.resultJson)).toEqual(direct.result);
      const verified = await verifyReplay(root, saved.replayId);
      const end = await seekReplay(root, saved.replayId, verified.checkpoint.nextRecord);
      expect(end.state!.actors.map((actor) => [actor.resources.hp, actor.immortalityUsed])).toEqual(
        [
          [1, 1],
          [1, 1],
        ],
      );
      const start = await seekReplay(root, saved.replayId, 1);
      expect(start.state!.actors.every((actor) => actor.immortalityUsed === undefined)).toBe(true);
      expect(await seekReplay(root, saved.replayId, verified.checkpoint.nextRecord)).toEqual(end);
    },
    {},
    20,
  );
}, 30000);

it('round-trips frozen clocks and pending contacts through Worker SQLite checkpoints and rewind', async () => {
  await withRuntime(async (f) => {
    const { done, saved, direct } = await runPersistedBattle(
      f,
      await stopManifest({ duration: 12, steps: 25 }),
      'p6-stop',
    );
    expect(done.state).toBe('completed');
    expect(JSON.parse(saved.resultJson)).toEqual(direct.result);
    const verified = await verifyReplay(f.root, saved.replayId);
    const pendingRecord =
      direct.records.findIndex(
        (record) =>
          'events' in record && record.events.some((event) => event.timeStop?.state === 'capture'),
      ) + 1;
    const pending = await seekReplay(f.root, saved.replayId, pendingRecord);
    expect(pending.deferred!.length).toBeGreaterThan(0);
    expect(pending.state!.actors[1]!.clock!.frozen).toBeDefined();
    expect(pending.state!.actors[1]!.resources.hp).toBe(40);
    const end = await seekReplay(f.root, saved.replayId, verified.checkpoint.nextRecord);
    expect(end.deferred).toEqual([]);
    expect(end.state!.actors[1]!.clock!.pausedSteps).toBe(12);
    expect(await seekReplay(f.root, saved.replayId, pendingRecord)).toEqual(pending);
    expect(await seekReplay(f.root, saved.replayId, verified.checkpoint.nextRecord)).toEqual(end);
  });
}, 30000);
