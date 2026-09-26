import { expect, it } from 'vite-plus/test';
import { ResultSchema } from '@fantasy/domain/spatial';
import { runBattle } from '@fantasy/engine/spatial';
import { relocationManifest } from '../../../../packages/engine/test-support/spatial-objects.ts';
import { withRuntime, specInput } from '../../test-support/runtime.ts';
import { seekReplay, verifyReplay } from '../replay/replay-reader.ts';

it('preserves discrete teleport boundaries through Worker SQLite and reverse replay seek', async () => {
  await withRuntime(
    async ({ runtime, store, jobs, root }) => {
      const input = await relocationManifest({}, 20);
      await store.seedRevisions(input.revisions);
      const spec = specInput(input),
        prepared = await store.prepareSpec(spec);
      const direct = await runBattle(prepared.manifest);
      const job = await runtime.submit(spec, 'p6-teleport', 'record');
      const completed = await runtime.wait(job.id);
      expect(completed.state).toBe('completed');
      const result = jobs.result(completed.resultId!)!;
      expect(ResultSchema.parse(JSON.parse(result.resultJson))).toEqual(direct.result);
      await verifyReplay(root, result.replayId);
      const boundary = direct.records.findIndex(
        (r) => r.kind === 'boundary' && r.events.some((e) => e.teleport),
      );
      for (const cursor of [boundary + 1, boundary, boundary + 1]) {
        const checkpoint = await seekReplay(root, result.replayId, cursor);
        expect(checkpoint.state!.actors.map((a) => a.position.x)).toEqual(
          cursor === boundary ? [-2, 2] : [-4, 4],
        );
      }
    },
    {},
    20,
  );
}, 30000);
