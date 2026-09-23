import { describe, expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import { StreamRecordSchema } from '@fantasy/domain/spatial';
import { catalogManifest, runBattle } from '@fantasy/engine/spatial';
import { withRuntime, specInput } from '../test-support/runtime.ts';
import { withReplayDirectory } from '../test-support/replays.ts';
import { batchInput, batchSource } from '../test-support/batches.ts';
import { createApp } from './app.ts';
import { readReplayChunk } from './replay-reader.ts';
import { createBatchPlan } from './batch-plan.ts';
import { runBatch, reconcileBatch } from './batch-runner.ts';
import { BattleBundles } from './battle-bundle.ts';

/** The API, persistence and headless paths must all execute the same prepared engine inputs. */
describe('observed AI delivery through persisted Workers', () => {
  it('prepares new typed characters through API, saves cognition, and isolates reused Worker knowledge', async () => {
    await withRuntime(
      async ({ runtime, store, root }) => {
        const manifest = await catalogManifest('fire-seer', 'ember-duelist', 'flat', 250, 42);
        await store.loadPinnedRevisions(manifest.revisions);
        const spec = specInput(manifest),
          app = createApp(store, false, runtime);
        try {
          const response = await app.inject({
            method: 'POST',
            url: '/api/battle-jobs',
            headers: { 'x-client-id': 'observed-ai', 'idempotency-key': 'one' },
            payload: { spec },
          });
          expect(response.statusCode).toBe(202);
          const done = await runtime.wait(response.json().job.id);
          expect(done.state).toBe('completed');
          const row = runtime.jobs.result(done.resultId!)!,
            saved = await runtime.artifacts.verified(row.replayId);
          expect(saved.input.aiProfile).toBe('observed-utility-v1');
          const records = [];
          for (let i = 0; i < saved.chunks.length; i++)
            for (const record of await readReplayChunk(join(root, saved.id), saved, i))
              records.push(StreamRecordSchema.parse(record));
          const cognition = records
            .flatMap((r) => ('events' in r ? r.events : []))
            .flatMap((e) => (e.cognition ? [e.cognition] : []));
          expect(
            cognition.some(
              (c) => c.kind === 'knowledge' && c.learned.some((k) => k.kind === 'reveal'),
            ),
          ).toBe(true);
          expect(cognition.some((c) => c.kind === 'decision' && c.candidates.length > 1)).toBe(
            true,
          );
          const next = await catalogManifest('water-observer', 'ember-duelist', 'flat', 250, 7);
          await store.loadPinnedRevisions(next.revisions);
          const job = await runtime.submit(specInput(next), 'isolation', 'two');
          const finished = await runtime.wait(job.id);
          expect(finished.state).toBe('completed');
          const actual = runtime.jobs.result(finished.resultId!)!;
          expect(JSON.parse(actual.resultJson)).toEqual((await runBattle(next)).result);
        } finally {
          await app.close();
        }
      },
      { workers: 1 },
      250,
    );
  }, 20000);
  it('runs, verifies and reuses new AI characters in the ordinary headless plan', async () => {
    await withReplayDirectory(async (root) => {
      const manifest = await catalogManifest('water-observer', 'ember-duelist', 'flat', 30, 42),
        base = await batchInput(1);
      const plan = await createBatchPlan(
        {
          ...base,
          revisions: manifest.revisions,
          matches: [{ key: 'observed-ai', spec: specInput(manifest) }],
        },
        batchSource,
      );
      const first = await runBatch(plan, root, batchSource);
      expect(first.index.complete).toBe(true);
      const again = await runBatch(plan, root, batchSource);
      expect(again.index.slots[0]!.reused).toBe(true);
      expect(
        (await reconcileBatch(plan, [{ index: first.index, bundles: new BattleBundles(root) }]))
          .complete,
      ).toBe(true);
    });
  }, 20000);
});
