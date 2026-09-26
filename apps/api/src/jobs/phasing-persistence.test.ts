import { expect, it } from 'vite-plus/test';
import { ResultSchema } from '@fantasy/domain/spatial';
import { runBattle } from '@fantasy/engine/spatial';
import { phasingManifest } from '../../../../packages/engine/test-support/phasing.ts';
import { withRuntime, specInput } from '../../test-support/runtime.ts';
import { seekReplay, verifyReplay } from '../replay/replay-reader.ts';

it('stores a bounded phasing exit truncation and restores active pending and final states', async () => {
  await withRuntime(
    async ({ runtime, store, jobs, root }) => {
      const input = await phasingManifest(65);
      await store.seedRevisions(input.revisions);
      const spec = specInput(input),
        prepared = await store.prepareSpec(spec),
        direct = await runBattle(prepared.manifest);
      const job = await runtime.submit(spec, 'p6-phase-exit', 'record'),
        complete = await runtime.wait(job.id);
      expect(complete.state).toBe('completed');
      const result = jobs.result(complete.resultId!)!;
      expect(ResultSchema.parse(JSON.parse(result.resultJson))).toEqual(direct.result);
      expect(direct.result.outcome).toMatchObject({
        kind: 'truncated',
        resource: 'phase-exit-steps',
      });
      await verifyReplay(root, result.replayId);
      const active = direct.records.findIndex(
        (r) => r.kind === 'boundary' && r.changes.some((a) => a.phasing?.active.length),
      );
      const pending = direct.records.findIndex(
        (r) => r.kind === 'boundary' && r.changes.some((a) => a.phasing?.exitPending),
      );
      for (const cursor of [pending + 1, active + 1, direct.records.length, pending + 1]) {
        const checkpoint = await seekReplay(root, result.replayId, cursor);
        expect(checkpoint.state!.actors.every((a) => !!a.phasing)).toBe(true);
        expect(checkpoint.state!.actors.every((a) => a.phasing!.exitPending)).toBe(
          cursor !== active + 1,
        );
        if (cursor === direct.records.length)
          expect(checkpoint.state!.actors.every((a) => a.phasing?.extendedIntervals === 50)).toBe(
            true,
          );
      }
    },
    {},
    65,
  );
}, 30000);
