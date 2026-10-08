import { expect, it } from 'vite-plus/test';
import { summoningManifest } from '../../../../packages/engine/test-support/summoning.ts';
import { withRuntime, runPersistedBattle } from '../../test-support/runtime.ts';
import { seekReplay, verifyReplay } from '../replay/replay-reader.ts';

it('round-trips dependents through worker, SQLite, seek and reverse navigation', async () => {
  await withRuntime(async (fixture) => {
    const { done, saved, direct } = await runPersistedBattle(
      fixture,
      await summoningManifest(),
      'sk07-dependent',
    );
    expect(done.state).toBe('completed');
    expect(JSON.parse(saved.resultJson)).toEqual(direct.result);
    const verified = await verifyReplay(fixture.root, saved.replayId);
    const activeCursor =
      direct.records.findIndex(
        (record) => 'dependents' in record && !!record.dependents?.spawn.length,
      ) + 1;
    const clearedCursor =
      direct.records.findIndex(
        (record, index) =>
          index + 1 > activeCursor && 'dependents' in record && !!record.dependents?.remove.length,
      ) + 1;
    expect(activeCursor).toBeGreaterThan(1);
    expect(clearedCursor).toBeGreaterThan(activeCursor);
    const active = await seekReplay(fixture.root, saved.replayId, activeCursor);
    expect(active.state?.dependents?.length).toBeGreaterThan(0);
    const cleared = await seekReplay(fixture.root, saved.replayId, clearedCursor);
    expect(cleared.state?.dependents ?? []).toHaveLength(0);
    const initial = await seekReplay(fixture.root, saved.replayId, 1);
    expect(initial.state?.dependents ?? []).toHaveLength(0);
    expect(await seekReplay(fixture.root, saved.replayId, activeCursor)).toEqual(active);
    expect(await seekReplay(fixture.root, saved.replayId, clearedCursor)).toEqual(cleared);
    const end = await seekReplay(fixture.root, saved.replayId, verified.checkpoint.nextRecord);
    expect(end.state?.dependents ?? []).toHaveLength(0);
  });
}, 30000);
