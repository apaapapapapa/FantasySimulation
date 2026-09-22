import { describe, expect, it } from 'vite-plus/test';
import { availableParallelism } from 'node:os';
import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { contentHash } from '@fantasy/domain/spatial';
import { createBatchPlan, shardSlots, validateBatchPlan } from './batch-plan.ts';
import { runBatch, reconcileBatch } from './batch-runner.ts';
import { BattleBundles } from './battle-bundle.ts';
import { batchInput, batchSource } from '../test-support/batches.ts';
import { withReplayDirectory } from '../test-support/replays.ts';
import { publishImmutableFile } from './replay-files.ts';

describe('immutable headless plans and portable result bundles', () => {
  it('fixes revision/seed/source identities and rejects duplicate, altered and oversized plans', async () => {
    const input = await batchInput(),
      plan = await createBatchPlan(input, batchSource);
    const reordered = await createBatchPlan(
      {
        ...input,
        matches: [...input.matches].reverse(),
        revisions: [...input.revisions].reverse(),
      },
      batchSource,
    );
    expect(reordered).toEqual(plan);
    expect(
      [0, 1, 2]
        .flatMap((i) => shardSlots(plan, i, 3))
        .map((s) => s.id)
        .sort(),
    ).toEqual(plan.slots.map((s) => s.id));
    await expect(createBatchPlan({ ...input, maxOutputBytes: 1 }, batchSource)).rejects.toThrow(
      /storage estimate/,
    );
    await expect(
      createBatchPlan({ ...input, matches: [input.matches[0], input.matches[0]] }, batchSource),
    ).rejects.toThrow(/Duplicate planned match/);
    await expect(
      createBatchPlan(
        { ...input, matches: [input.matches[0], { ...input.matches[0], key: 'alias' }] },
        batchSource,
      ),
    ).rejects.toThrow(/Duplicate planned simulation/);
    await expect(validateBatchPlan(plan, { ...batchSource, sha: 'b'.repeat(40) })).rejects.toThrow(
      /pinned plan/,
    );
    const changed = structuredClone(plan);
    changed.slots[0]!.simulationHash = 'sha256:' + '0'.repeat(64);
    const { id: _, ...body } = changed;
    changed.id = await contentHash(body);
    await expect(validateBatchPlan(changed, batchSource)).rejects.toThrow(/identity mismatch/);
  });
  it('compares one Worker with reversed sharded execution, resumes, and reconciles every expected slot exactly once', async () => {
    await withReplayDirectory(async (root) => {
      const plan = await createBatchPlan(await batchInput(), batchSource);
      const singleRoot = join(root, 'single'),
        shardRoot = join(root, 'shards');
      const stopped = await runBatch(plan, singleRoot, batchSource, { deadlineMs: 1 });
      expect(stopped.index.complete).toBe(false);
      expect(stopped.index.slots.every((s) => s.state === 'pending')).toBe(true);
      const single = await runBatch(plan, singleRoot, batchSource);
      expect(single.index.complete).toBe(true);
      const parallel = Math.min(4, Math.max(1, availableParallelism() - 1));
      const shards = [];
      for (let i = 0; i < 2; i++)
        shards.push(
          await runBatch(plan, shardRoot, batchSource, {
            workers: parallel,
            reverse: true,
            shardIndex: i,
            shardCount: 2,
          }),
        );
      const results = shards.flatMap((r) => r.index.slots);
      expect(results.filter((s) => s.state !== 'complete')).toEqual([]);
      for (const slot of single.index.slots)
        expect(results.find((s) => s.slotId === slot.slotId)?.receipt?.resultHash).toBe(
          slot.receipt?.resultHash,
        );
      const bundles = new BattleBundles(shardRoot);
      const indexes = shards.map((r) => ({ index: r.index, bundles }));
      expect(await reconcileBatch(plan, indexes)).toMatchObject({
        planned: 4,
        recorded: 4,
        complete: true,
        missing: [],
      });
      expect((await reconcileBatch(plan, [])).complete).toBe(false);
      expect((await reconcileBatch(plan, [indexes[0]!])).complete).toBe(
        indexes[0]!.index.slots.length === plan.slots.length,
      );
      const nonempty = indexes.find((r) => r.index.slots.length > 0)!;
      await expect(reconcileBatch(plan, [...indexes, nonempty])).rejects.toThrow(/duplicate/);
      const resumed = await runBatch(plan, singleRoot, batchSource, { reverse: true });
      expect(resumed.index.slots.every((s) => s.reused)).toBe(true);
      expect(resumed.index.slots.map((s) => s.receipt)).toEqual(
        single.index.slots.map((s) => s.receipt),
      );
      // A new plan reuses existing simulations and runs only its added seed.
      const extended = await createBatchPlan(await batchInput(5), batchSource);
      const added = await runBatch(extended, singleRoot, batchSource);
      expect(added.index.slots.filter((s) => s.reused)).toHaveLength(4);
      expect(added.index.complete).toBe(true);
      const text = await readFile(added.path, 'utf8');
      expect(text).not.toContain(root);
      expect(text).not.toContain('database.sqlite');
    });
  }, 20_000);
  it('holds corruption and treats truncated records as incomplete without promoting them into cache', async () => {
    await withReplayDirectory(async (root) => {
      const input = await batchInput(1),
        plan = await createBatchPlan(input, batchSource);
      const initial = await runBatch(plan, root, batchSource);
      const receipt = initial.index.slots[0]!.receipt!;
      const directory = join(root, 'objects', receipt.objectHash.slice(7));
      const file = (await readdir(directory)).find((n) => n.endsWith('.gz'))!;
      await writeFile(join(directory, file), 'corrupted');
      const held = await runBatch(plan, root, batchSource);
      expect(held.index.slots[0]!.state).toBe('failed');
      expect(held.index.slots[0]!.reason).toMatch(/size|checksum/);
      await expect(
        reconcileBatch(plan, [{ index: initial.index, bundles: new BattleBundles(root) }]),
      ).rejects.toThrow(/size|checksum/);
      const small = await createBatchPlan(
        { ...input, budget: { ...input.budget, maxBytes: 1 } },
        batchSource,
      );
      const other = join(root, '.work', 'truncated-output');
      const truncated = await runBatch(small, other, batchSource);
      expect(truncated.index.slots[0]!.state).toBe('truncated');
      expect(truncated.index.complete).toBe(false);
      expect(await new BattleBundles(other).cached(small.slots[0]!.simulationHash)).toBeNull();
    });
  });
  it('recovers a missing publication pointer and generated staging while preserving immutable files', async () => {
    await withReplayDirectory(async (root) => {
      const plan = await createBatchPlan(await batchInput(1), batchSource);
      const initial = await runBatch(plan, root, batchSource);
      const receipt = initial.index.slots[0]!.receipt!;
      await rm(join(root, 'complete', receipt.simulationHash.slice(7) + '.json'));
      const staging = join(root, `.bundle-staging-${randomUUID()}`);
      await mkdir(staging);
      await writeFile(join(staging, 'partial'), 'partial');
      const next = await runBatch(plan, root, batchSource);
      expect(next.index.slots[0]!.receipt).toEqual(receipt);
      expect(await readdir(root)).not.toContain(staging.split(/[\\/]/).at(-1));
      await expect(publishImmutableFile(initial.path, 'replacement')).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(JSON.parse(await readFile(initial.path, 'utf8')).id).toBe(initial.index.id);
      const tight = new BattleBundles(root, 1);
      await expect(tight.storedBytes()).rejects.toThrow(/storage limit/);
    });
  });
});
