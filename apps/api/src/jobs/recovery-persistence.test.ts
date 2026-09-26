import { expect, it } from 'vite-plus/test';
import { ResultSchema } from '@fantasy/domain/spatial';
import { runBattle } from '@fantasy/engine/spatial';
import { recoveryManifest } from '../../../../packages/engine/test-support/recovery.ts';
import { withRuntime, specInput } from '../../test-support/runtime.ts';
import { seekReplay, verifyReplay } from '../replay/replay-reader.ts';

it('round-trips absorbed and drained recovery through a real Worker SQLite and replay seek', async () => {
  await withRuntime(
    async ({ runtime, store, jobs, root }) => {
      const input = await recoveryManifest();
      await store.seedRevisions(input.revisions);
      const prepared = await store.prepareSpec(specInput(input));
      const direct = await runBattle(prepared.manifest);
      const job = await runtime.submit(specInput(input), 'p6-recovery', 'persist');
      const done = await runtime.wait(job.id);
      expect(done.state).toBe('completed');
      const saved = jobs.result(done.resultId!)!;
      expect(ResultSchema.parse(JSON.parse(saved.resultJson))).toEqual(direct.result);
      const verified = await verifyReplay(root, saved.replayId);
      const end = await seekReplay(root, saved.replayId, verified.checkpoint.nextRecord);
      expect(end.state!.actors.map((a) => a.resources.hp)).toEqual([75, 100]);
      const start = await seekReplay(root, saved.replayId, 1);
      expect(start.state!.actors.map((a) => a.resources.hp)).toEqual([100, 100]);
      expect(await seekReplay(root, saved.replayId, verified.checkpoint.nextRecord)).toEqual(end);
    },
    {},
    20,
  );
}, 30000);
