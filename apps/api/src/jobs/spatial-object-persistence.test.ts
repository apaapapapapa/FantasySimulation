import { expect, it } from 'vite-plus/test';
import { ResultSchema } from '@fantasy/domain/spatial';
import { runBattle } from '@fantasy/engine/spatial';
import { objectManifest } from '../../../../packages/engine/test-support/object-manifest.ts';
import { withRuntime, specInput } from '../../test-support/runtime.ts';
import { seekReplay, verifyReplay } from '../replay/replay-reader.ts';

it.each(['barrier', 'area', 'beam'] as const)(
  'persists %s objects through Worker SQLite and restores both sides of activation',
  async (kind) => {
    await withRuntime(
      async ({ runtime, store, jobs, root }) => {
        const input = await objectManifest(kind, {}, 20);
        await store.seedRevisions(input.revisions);
        const spec = specInput(input),
          prepared = await store.prepareSpec(spec),
          direct = await runBattle(prepared.manifest);
        const job = await runtime.submit(spec, `p6-${kind}`, 'record'),
          complete = await runtime.wait(job.id);
        expect(complete.state).toBe('completed');
        const result = jobs.result(complete.resultId!)!;
        expect(ResultSchema.parse(JSON.parse(result.resultJson))).toEqual(direct.result);
        await verifyReplay(root, result.replayId);
        const activation = direct.records.findIndex(
          (r) => (r.kind === 'boundary' || r.kind === 'interval') && r.objects?.spawn.length,
        );
        expect(activation).toBeGreaterThan(0);
        for (const cursor of [activation + 1, activation, activation + 1]) {
          const checkpoint = await seekReplay(root, result.replayId, cursor);
          expect(checkpoint.state?.objects?.length ?? 0).toBe(cursor === activation ? 0 : 2);
          expect(checkpoint.state?.objects?.every((o) => o.kind === kind) ?? true).toBe(true);
        }
      },
      {},
      20,
    );
  },
  30000,
);
