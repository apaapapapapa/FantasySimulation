import { expect, it } from 'vite-plus/test';
import { sensoryCueManifest } from '../../../../packages/engine/test-support/sensory-cues.ts';
import { withRuntime, runPersistedBattle } from '../../test-support/runtime.ts';
import { seekReplay, verifyReplay } from '../replay/replay-reader.ts';

it('round-trips sensory cue lifecycle through Worker, SQLite and reverse replay seek', async () => {
  await withRuntime(async (fixture) => {
    const { done, saved, direct } = await runPersistedBattle(
      fixture,
      await sensoryCueManifest(),
      'sk06-sensory-cue',
    );
    expect(done.state).toBe('completed');
    expect(JSON.parse(saved.resultJson)).toEqual(direct.result);
    const verified = await verifyReplay(fixture.root, saved.replayId);
    const activeCursor =
      direct.records.findIndex(
        (record) =>
          'changes' in record &&
          record.changes.some((actor) => (actor.sensoryCues?.length ?? 0) > 0),
      ) + 1;
    const clearedCursor =
      direct.records.findIndex(
        (record, index) =>
          index + 1 > activeCursor &&
          'changes' in record &&
          record.changes.some((actor) => actor.sensoryCues?.length === 0),
      ) + 1;
    expect(activeCursor).toBeGreaterThan(1);
    expect(clearedCursor).toBeGreaterThan(activeCursor);

    const active = await seekReplay(fixture.root, saved.replayId, activeCursor);
    expect(active.state!.actors.some((actor) => actor.sensoryCues?.length)).toBeTruthy();
    const cleared = await seekReplay(fixture.root, saved.replayId, clearedCursor);
    expect(cleared.state!.actors.every((actor) => actor.sensoryCues?.length === 0)).toBe(true);
    const start = await seekReplay(fixture.root, saved.replayId, 1);
    expect(start.state!.actors.every((actor) => actor.sensoryCues?.length === 0)).toBe(true);
    expect(await seekReplay(fixture.root, saved.replayId, activeCursor)).toEqual(active);
    expect(await seekReplay(fixture.root, saved.replayId, clearedCursor)).toEqual(cleared);
    const end = await seekReplay(fixture.root, saved.replayId, verified.checkpoint.nextRecord);
    expect(end.state!.actors.every((actor) => actor.sensoryCues?.length === 0)).toBe(true);
  });
}, 30000);
