import { join } from 'node:path';
import { StreamRecordSchema } from '@fantasy/domain/spatial';
import { describe, expect, it } from 'vite-plus/test';
import { runBattle } from '@fantasy/engine/spatial';
import { simultaneousManifest } from '../../../packages/engine/test-support/simultaneous.ts';
import { stagedManifest } from '../../../packages/engine/test-support/stages.ts';
import { initialStatus } from '../../../packages/engine/test-support/ai.ts';
import { battleEvents } from '../../../packages/engine/test-support/fixtures.ts';
import { specInput, withRuntime } from '../test-support/runtime.ts';
import { readReplayChunk, readReplayManifest, seekReplay, verifyReplay } from './replay-reader.ts';

describe('simultaneous slots through persisted Workers', () => {
  it.each(['joint', 'staged'] as const)(
    'preserves %s decisions, costs and replacement displays across forward and backward seeks',
    async (mode) => {
      await withRuntime(
        async ({ runtime, store, root }) => {
          const input = await (mode === 'joint'
            ? simultaneousManifest()
            : stagedManifest({ status: initialStatus() }));
          await store.seedRevisions(input.revisions);
          const direct = await runBattle(input);
          const submitted = await runtime.submit(specInput(input), 'simultaneous', 'persist');
          const done = await runtime.wait(submitted.id);
          expect(done.state).toBe('completed');
          const result = runtime.jobs.result(done.resultId!)!;
          expect(JSON.parse(result.resultJson)).toEqual(direct.result);
          const manifest = await readReplayManifest(root, result.replayId);
          const verified = await verifyReplay(root, result.replayId);
          const records = (
            await Promise.all(
              manifest.chunks.map((chunk) =>
                readReplayChunk(join(root, manifest.id), manifest, chunk.index),
              ),
            )
          ).flat();
          const events = battleEvents(records.map((r) => StreamRecordSchema.parse(r)));
          if (mode === 'joint')
            expect(
              events.filter(
                (e) =>
                  e.cognition?.kind === 'decision' &&
                  e.cognition.movementSlot?.selection === 'dodge',
              ),
            ).not.toHaveLength(0);
          else {
            expect(events.filter((e) => e.kind === 'hit').map((e) => e.stage?.stageId)).toEqual([
              'cut',
              'cut',
              'return',
              'return',
            ]);
            expect(events.filter((e) => e.kind === 'stage-start')).toHaveLength(4);
            expect(store.getSpec(done.simulationHash)?.manifest).toEqual(manifest.input);
            expect(
              events.filter((e) => e.reason === 'apply-status').map((e) => e.stage?.stageId),
            ).toEqual(['return', 'return']);
          }
          for (const cursor of [manifest.records, 1, manifest.records]) {
            const state = await seekReplay(root, manifest.id, cursor);
            expect(state.nextRecord).toBe(cursor);
            if (cursor === manifest.records) expect(state).toEqual(verified.checkpoint);
          }
        },
        {},
        mode === 'joint' ? 50 : 25,
      );
    },
  );
});
