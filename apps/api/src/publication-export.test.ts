import { describe, expect, it } from 'vite-plus/test';
import { readFile, writeFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  canonicalJson,
  contentHash,
  PublicKeySchema,
  PublicMatchRowSchema,
  assertPublicReplayBinding,
  assertPublicPageBinding,
  type BatchIndex,
} from '@fantasy/domain/spatial';
import { withReplayDirectory } from '../test-support/replays.ts';
import {
  publicationFixture,
  publicationIndex,
  expandPublicationPlan,
  readPublication,
} from '../test-support/publication.ts';
import { exportPublication } from './publication-export.ts';
import { shardSlots, reconcileBatch } from './batch-check.ts';
import { sha256 } from './replay-files.ts';

describe('public saved-batch export', () => {
  it('preserves every bundle byte and stable hashes on repeat export, with no work files or diagnostics', async () => {
    await withReplayDirectory(async (root) => {
      const fixture = await publicationFixture(join(root, 'batch')),
        target = join(root, 'public');
      await writeFile(join(root, 'batch/.work/local.sqlite'), 'private database');
      await writeFile(join(root, 'batch/.env'), 'PRIVATE_VALUE=local-only');
      fixture.index.slots[0]!.reason = 'failed earlier at /home/operator/.env token=local-only';
      fixture.index = await publicationIndex(fixture.plan, fixture.index.slots);
      const result = await exportPublication(fixture.plan, [fixture], target);
      expect(result).toMatchObject({
        totalRows: 1,
        incompleteRows: 0,
        complete: true,
        reusedFiles: 0,
      });
      const output = await readPublication(target),
        set = output.sets[0]!;
      expect(set.rows[0]).toMatchObject({
        state: 'complete',
        reason: 'verified-result',
        result: { steps: 6, outcome: { kind: 'draw', reason: 'mutual-defeat' } },
        playback: 'full',
        records: fixture.manifest.records,
        seed: fixture.plan.slots[0]!.spec.seed,
      });
      expect(set.rows[0]!.participants.map((p) => p.character.name)).toEqual(
        fixture.plan.slots[0]!.spec.participants.map(
          (p) => fixture.plan.revisions.find((r) => r.id === p.character.id)!.definition.name,
        ),
      );
      expect(() =>
        assertPublicReplayBinding(set.rows[0]!, fixture.receipt, fixture.manifest),
      ).not.toThrow();
      expect(() => assertPublicPageBinding(set.set, set.pages[0]!)).not.toThrow();
      const paths = await readdir(target, { recursive: true, withFileTypes: true });
      for (const entry of paths.filter((e) => e.isFile())) {
        const path = join(entry.parentPath, entry.name),
          key = path.slice(target.length + 1);
        expect(PublicKeySchema.safeParse(key).success).toBe(true);
        const data = await readFile(path);
        if (key.startsWith('objects/'))
          expect(data).toEqual(await readFile(join(fixture.object, entry.name)));
        else if (key !== 'catalog/current.json')
          expect(sha256(data)).toBe(
            'sha256:' +
              (entry.name === 'set.json' ? set.ref.setHash.slice(7) : entry.name.slice(0, -5)),
          );
        if (key.endsWith('.json'))
          expect(data.toString('utf8')).not.toMatch(/local-only|local\.sqlite|\/home\/operator/);
      }
      const repeated = await exportPublication(fixture.plan, [fixture], target, result.bytes);
      expect(repeated).toMatchObject({
        setHash: result.setHash,
        catalogHash: result.catalogHash,
        addedFiles: 0,
        reusedFiles: result.addedFiles,
      });
      expect(await readPublication(target)).toEqual(output);
    });
  });

  it('retains all 1000 planned slots, paginates at 100, and distinguishes missing shards from failed/pending slots', async () => {
    await withReplayDirectory(async (root) => {
      const f = await publicationFixture(join(root, 'batch')),
        target = join(root, 'public');
      const plan = await expandPublicationPlan(f.plan, 1000),
        selected = shardSlots(plan, 0, 2);
      const slots: BatchIndex['slots'] = selected.map((s, i) => ({
        slotId: s.id,
        simulationHash: s.simulationHash,
        state: i === 0 ? 'failed' : 'pending',
        receipt: null,
        reused: false,
        reason: 'private failure /home/operator/file',
      }));
      const index = await publicationIndex(plan, slots, 0, 2);
      const result = await exportPublication(plan, [{ index, bundles: f.bundles }], target);
      expect(result).toMatchObject({
        complete: false,
        totalRows: 1000,
        incompleteRows: 1000,
        counts: { complete: 0, failed: 1, pending: 999 },
      });
      const set = (await readPublication(target)).sets[0]!;
      expect(set.pages.map((p) => p.rows.length)).toEqual(Array(10).fill(100));
      expect(set.rows.map((r) => r.slotId)).toEqual(plan.slots.map((s) => s.id));
      expect(set.rows.filter((r) => r.reason === 'missing-shard')).toHaveLength(
        1000 - selected.length,
      );
      expect(
        set.rows.every(
          (r) => r.replay === null && r.result === null && r.playback === 'unavailable',
        ),
      ).toBe(true);
      expect((await readdir(target)).sort()).toEqual(['catalog', 'sets']);
    });
  });

  it.each(['truncated', 'unresolved'] as const)(
    'exports %s only as a verified partial recording',
    async (kind) => {
      await withReplayDirectory(async (root) => {
        const f = await publicationFixture(join(root, 'batch'), kind),
          target = join(root, 'public');
        expect(await exportPublication(f.plan, [f], target)).toMatchObject({
          complete: false,
          incompleteRows: 1,
        });
        const row = (await readPublication(target)).sets[0]!.rows[0]!;
        expect(row).toMatchObject({
          state: kind,
          playback: 'partial',
          records: f.manifest.records,
          lastVerifiedStep: 6,
          replay: { objectHash: f.receipt.objectHash },
        });
        expect(PublicMatchRowSchema.safeParse({ ...row, reused: true }).success).toBe(false);
        const index = await publicationIndex(
          f.plan,
          f.index.slots.map((slot) => ({ ...slot, reused: true })),
        );
        const forged = [{ index, bundles: f.bundles }];
        await expect(reconcileBatch(f.plan, forged)).rejects.toThrow(/Slot state/);
        await expect(exportPublication(f.plan, forged, target)).rejects.toThrow(/Slot state/);
      });
    },
  );

  it('adds a new catalog generation for reused results while keeping old set links and bundle bytes', async () => {
    await withReplayDirectory(async (root) => {
      const f = await publicationFixture(join(root, 'batch')),
        target = join(root, 'public');
      const first = await exportPublication(f.plan, [f], target);
      const index = await publicationIndex(
        f.plan,
        f.index.slots.map((s) => ({ ...s, reused: true })),
      );
      const next = await exportPublication(f.plan, [{ index, bundles: f.bundles }], target);
      const data = await readPublication(target);
      expect(data.catalog.previousCatalogHash).toBe(first.catalogHash);
      expect(data.sets).toHaveLength(2);
      expect(data.sets.find((s) => s.ref.setHash === first.setHash)!.rows[0]!.reused).toBe(false);
      expect(data.sets.find((s) => s.ref.setHash === next.setHash)!.rows[0]!.reused).toBe(true);
      expect(await readdir(join(target, 'objects'))).toEqual([f.receipt.objectHash.slice(7)]);
      expect(next.addedFiles).toBe(3);
    });
  });

  it.each(['missing', 'reference', 'row', 'state', 'duplicate', 'mixed-shards'] as const)(
    'rejects %s inconsistencies before creating output',
    async (fault) => {
      await withReplayDirectory(async (root) => {
        const f = await publicationFixture(join(root, 'batch')),
          target = join(root, 'public');
        if (fault === 'missing') await rm(join(f.object, f.manifest.chunks[0]!.file));
        if (fault === 'reference') f.index.slots[0]!.receipt!.attemptId = 'wrong-attempt';
        if (fault === 'state') f.index.slots[0]!.state = 'truncated';
        if (fault === 'row') {
          f.plan.slots[0]!.spec.participants.reverse();
          const { id: _, ...body } = f.plan;
          f.plan.id = await contentHash(body);
        }
        f.index = await publicationIndex(f.plan, f.index.slots);
        const entries =
          fault === 'duplicate'
            ? [f, f]
            : fault === 'mixed-shards'
              ? [f, { ...f, index: await publicationIndex(f.plan, [], 1, 2) }]
              : [f];
        await expect(exportPublication(f.plan, entries, target)).rejects.toThrow();
        await expect(readdir(target)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    },
  );

  it('preflights immutable collisions and capacity without advancing the current pointer', async () => {
    await withReplayDirectory(async (root) => {
      const f = await publicationFixture(join(root, 'batch')),
        target = join(root, 'public');
      await expect(exportPublication(f.plan, [f], target, 1)).rejects.toThrow(/capacity/);
      expect(await readdir(target)).toEqual([]);
      await exportPublication(f.plan, [f], target);
      const pointer = await readFile(join(target, 'catalog/current.json'));
      await writeFile(
        join(target, 'objects', f.receipt.objectHash.slice(7), 'manifest.json'),
        '{}',
      );
      await expect(exportPublication(f.plan, [f], target)).rejects.toThrow(/collision/);
      expect(await readFile(join(target, 'catalog/current.json'))).toEqual(pointer);
    });
  });

  it('rejects a different verified result for the same simulation in a later export', async () => {
    await withReplayDirectory(async (root) => {
      const a = await publicationFixture(join(root, 'a')),
        b = await publicationFixture(join(root, 'b'), 'truncated'),
        target = join(root, 'public');
      await exportPublication(a.plan, [a], target);
      const pointer = await readFile(join(target, 'catalog/current.json'));
      await expect(exportPublication(b.plan, [b], target)).rejects.toThrow(/result conflict/);
      expect(await readFile(join(target, 'catalog/current.json'))).toEqual(pointer);
    });
  });

  it('refuses symlink directories and overlapping roots', async () => {
    await withReplayDirectory(async (root) => {
      const f = await publicationFixture(join(root, 'batch')),
        target = join(root, 'public');
      await mkdir(target);
      await symlink(join(root, 'batch'), join(target, 'objects'));
      await expect(exportPublication(f.plan, [f], target)).rejects.toThrow(/symlink/);
      await expect(exportPublication(f.plan, [f], join(root, 'batch/public'))).rejects.toThrow(
        /separate/,
      );
    });
  });

  it('runs the real CLI with execution/SQLite imports blocked and uses exit 2 for incomplete output', async () => {
    await withReplayDirectory(async (root) => {
      const f = await publicationFixture(join(root, 'batch'));
      const planPath = join(root, 'plan.json'),
        indexPath = join(root, 'index.json');
      await writeFile(planPath, canonicalJson(f.plan));
      for (const pending of [false, true]) {
        const index = pending
          ? await publicationIndex(
              f.plan,
              f.index.slots.map((s) => ({ ...s, state: 'pending', receipt: null })),
            )
          : f.index;
        await writeFile(indexPath, canonicalJson(index));
        const result = spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            '--import',
            './test-support/publication-loader.ts',
            'src/batch.ts',
            'export',
            planPath,
            join(root, `public-${pending}`),
            indexPath,
            f.bundles.root,
          ],
          { cwd: resolve('apps/api'), encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000 },
        );
        expect(result.stderr).toBe('');
        expect(result.status).toBe(pending ? 2 : 0);
        expect(JSON.parse(result.stdout)).toMatchObject({ complete: !pending, totalRows: 1 });
      }
    });
  });
});
