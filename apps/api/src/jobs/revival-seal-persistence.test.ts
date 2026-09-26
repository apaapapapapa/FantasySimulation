import { expect, it } from 'vite-plus/test';
import { ResultSchema } from '@fantasy/domain/spatial';
import { revivalManifest } from '../../../../packages/engine/test-support/revival.ts';
import { initialStatus, withInitialStatus } from '../../../../packages/engine/test-support/ai.ts';
import { withRuntime, runPersistedBattle } from '../../test-support/runtime.ts';
import { seekReplay, verifyReplay } from '../replay/replay-reader.ts';

it.each([false, true])(
  'persists revival and sealed reactions through Worker SQLite seek and rewind, sealed=%s',
  async (sealed) => {
    await withRuntime(
      async ({ runtime, store, jobs, root }) => {
        const input = await revivalManifest();
        if (sealed)
          for (const i of [0, 1] as const)
            await withInitialStatus(
              input,
              i,
              initialStatus({ seals: { abilityCategories: ['special'] }, durationSteps: 20 }),
            );
        const { direct, done, saved } = await runPersistedBattle(
          { runtime, store, jobs },
          input,
          'p6-revival-seal',
        );
        expect(done.state).toBe('completed');
        expect(ResultSchema.parse(JSON.parse(saved.resultJson))).toEqual(direct.result);
        const verified = await verifyReplay(root, saved.replayId);
        const end = await seekReplay(root, saved.replayId, verified.checkpoint.nextRecord);
        expect(end.state!.actors.map((a) => [a.resources.hp, a.revivals])).toEqual(
          sealed
            ? [
                [0, 0],
                [0, 0],
              ]
            : [
                [7, 1],
                [7, 1],
              ],
        );
        const start = await seekReplay(root, saved.replayId, 1);
        expect(start.state!.actors.map((a) => a.revivals)).toEqual([0, 0]);
        expect(await seekReplay(root, saved.replayId, verified.checkpoint.nextRecord)).toEqual(end);
      },
      {},
      8,
    );
  },
  30000,
);
