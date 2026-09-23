import { join } from 'node:path';
import { StreamRecordSchema } from '@fantasy/domain/spatial';
import { describe, expect, it } from 'vite-plus/test';
import { runBattle } from '@fantasy/engine/spatial';
import { simultaneousManifest } from '../../../packages/engine/test-support/simultaneous.ts';
import { battleEvents } from '../../../packages/engine/test-support/fixtures.ts';
import { specInput, withRuntime } from '../test-support/runtime.ts';
import { readReplayChunk, readReplayManifest, seekReplay, verifyReplay } from './replay-reader.ts';

describe('simultaneous slots through persisted Workers', () => {
  it('preserves joint decisions, costs and replacement displays across forward and backward seeks', async () => {
    await withRuntime(async ({ runtime, store, root }) => {
      const input = await simultaneousManifest();
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
      expect(
        battleEvents(records.map((r) => StreamRecordSchema.parse(r))).filter(
          (e) =>
            e.cognition?.kind === 'decision' && e.cognition.movementSlot?.selection === 'dodge',
        ),
      ).not.toHaveLength(0);
      for (const cursor of [manifest.records, 1, manifest.records]) {
        const state = await seekReplay(root, manifest.id, cursor);
        expect(state.nextRecord).toBe(cursor);
        if (cursor === manifest.records) expect(state).toEqual(verified.checkpoint);
      }
    });
  });
});
