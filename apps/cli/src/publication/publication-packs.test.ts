import { expect, it, vi } from 'vite-plus/test';
import { readFile, writeFile, readdir, rename, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BattleBundles, sha256 } from '@fantasy/api/artifacts';
import { withReplayDirectory } from '@fantasy/api/testing';
import {
  PackIndexSchema,
  PublicMatchPageSchema,
  canonicalJson,
  packKey,
  packIndexKey,
} from '@fantasy/domain/spatial';
import { publicationFixture, readPublication } from '../../test-support/publication.ts';
import { exportPublication } from './publication-export.ts';
import { localPublicationGraph, publicationGraph } from './publication-graph.ts';
import { restorePublication } from './publication-restore.ts';
import { publishPublication } from './publication-remote.ts';

it('round-trips exact original bytes through packs, restore, verifier Workers and reuse without an engine', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await publicationFixture(join(root, 'batch')),
      target = join(root, 'public');
    const first = await exportPublication(fixture.plan, [fixture], target, undefined, true);
    const graph = await localPublicationGraph(target, 2);
    expect(graph.current.schemaVersion).toBe(2);
    expect([...graph.files.keys()].some((key) => key.startsWith('objects/'))).toBe(false);
    const indexFile = [...graph.files.values()].find((file) =>
      file.key.startsWith('pack-indexes/'),
    )!;
    const index = PackIndexSchema.parse(
      JSON.parse((await readFile(indexFile.source!)).toString('utf8')),
    );
    const packed = await readFile(join(target, packKey(index.packHash)));
    expect(index.entries.map((entry) => entry.key)).toEqual(
      index.entries.map((entry) => entry.key).sort(),
    );
    for (const entry of index.entries)
      expect(packed.subarray(entry.offset, entry.offset + entry.bytes)).toEqual(
        await readFile(join(fixture.object, entry.key.split('/').at(-1)!)),
      );
    expect(indexFile.key).toBe(packIndexKey(sha256(canonicalJson(index))));
    const output = await readPublication(target),
      page = output.sets[0]!.pages[0]!;
    expect(PublicMatchPageSchema.safeParse({ ...page, schemaVersion: 1 }).success).toBe(false);
    expect(
      await exportPublication(fixture.plan, [fixture], target, first.bytes, true),
    ).toMatchObject({ catalogHash: first.catalogHash, addedFiles: 0 });
    const restored = join(root, 'restored');
    await restorePublication(restored, {
      read: async (key) => ({ data: await readFile(join(target, key)), etag: 'stable' }),
    });
    expect((await localPublicationGraph(restored)).current).toEqual(graph.current);
    const bundles = new BattleBundles(restored);
    expect(await bundles.verify(fixture.receipt.objectHash)).toEqual(fixture.receipt);
    expect(
      await new BattleBundles(join(root, 'imported')).importConfirmed(
        bundles,
        fixture.receipt.objectHash,
      ),
    ).toEqual(fixture.receipt);
    expect(
      await readFile(
        join(root, 'imported/objects', fixture.receipt.objectHash.slice(7), 'receipt.json'),
      ),
    ).toEqual(await readFile(join(fixture.object, 'receipt.json')));
    await exportPublication(
      fixture.plan,
      [{ index: fixture.index, bundles: new BattleBundles(join(root, 'imported')) }],
      join(root, 'reexport'),
      undefined,
      true,
    );
    expect((await localPublicationGraph(join(root, 'reexport'))).current).toEqual(graph.current);
  });
});
it('keeps v1 generations readable when adding packs and rejects damage before transport admission', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await publicationFixture(join(root, 'batch')),
      target = join(root, 'public');
    await exportPublication(fixture.plan, [fixture], target);
    const before = await localPublicationGraph(target);
    await exportPublication(fixture.plan, [fixture], target, undefined, true);
    const graph = await localPublicationGraph(target);
    for (const key of before.files.keys()) expect(graph.files.has(key)).toBe(true);
    expect(graph.catalog.previousCatalogHash).toBe(before.current.catalogHash);
    const pack = [...graph.files.values()].find((file) => file.key.startsWith('packs/'))!;
    const bytes = await readFile(pack.source!);
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(pack.source!, bytes);
    const destination = vi.fn();
    await expect(
      publishPublication(target, destination, {
        viewer: vi.fn(),
        ancestor: () => true,
        worker: vi.fn(async () => Buffer.alloc(0)),
      }),
    ).rejects.toMatchObject({ phase: 'not-committed' });
    expect(destination).not.toHaveBeenCalled();
    expect((await readdir(target)).sort()).toEqual([
      'catalog',
      'objects',
      'pack-indexes',
      'packs',
      'sets',
    ]);
  });
});
it('finishes durable packs before exposing indexes and recovers identical bytes after a failed write', async () => {
  await withReplayDirectory(async (root) => {
    const artifacts = await import('@fantasy/api/artifacts');
    const fixture = await publicationFixture(join(root, 'batch')),
      target = join(root, 'public');
    await exportPublication(fixture.plan, [fixture], target);
    const pointer = await readFile(join(target, 'catalog/current.json'));
    const original = artifacts.publishImmutableFile,
      writes: string[] = [];
    const write = vi
      .spyOn(artifacts, 'publishImmutableFile')
      .mockImplementation(async (path, bytes) => {
        writes.push(path);
        if (path.includes('/packs/')) throw new Error('Injected fsync failure');
        await original(path, bytes);
      });
    try {
      await expect(
        exportPublication(fixture.plan, [fixture], target, undefined, true),
      ).rejects.toThrow('Injected fsync');
      expect(writes.some((path) => path.includes('/pack-indexes/'))).toBe(false);
      expect(await readFile(join(target, 'catalog/current.json'))).toEqual(pointer);
    } finally {
      write.mockRestore();
    }
    const recovered = await exportPublication(fixture.plan, [fixture], target, undefined, true);
    expect((await localPublicationGraph(target)).current.catalogHash).toBe(recovered.catalogHash);
    expect(await exportPublication(fixture.plan, [fixture], target, undefined, true)).toMatchObject(
      { addedFiles: 0, catalogHash: recovered.catalogHash },
    );
  });
});
it('closes fixed groups of 64 and splits a large replay only between bounded original entries', async () => {
  await withReplayDirectory(async (root) => {
    const { packPublication } = await import('./publication-packs.ts');
    const { publicationBytes } = await import('./publication-files.ts');
    const fixture = await publicationFixture(join(root, 'batch')),
      target = join(root, 'public');
    await exportPublication(fixture.plan, [fixture], target);
    const row = (await readPublication(target)).sets[0]!.rows[0]!;
    const rows = Array.from({ length: 65 }, (_, i) => ({
      ...row,
      slotId: 'sha256:' + i.toString(16).padStart(64, '0'),
      replay: { ...row.replay!, objectHash: 'sha256:' + i.toString(16).padStart(64, '0') },
    }));
    const data = Buffer.from('{}');
    const files = rows.map((row) => ({
      key: `objects/${row.replay.objectHash.slice(7)}/manifest.json`,
      data,
      bytes: data.length,
      checksum: sha256(data),
    }));
    const packed = await packPublication([...files].reverse(), rows);
    expect(packed.filter((file) => file.key.startsWith('packs/'))).toHaveLength(2);
    expect(rows[0]!.replay).toMatchObject({ packs: expect.any(Array) });
    const indexes = packed
      .filter((file) => file.key.startsWith('pack-indexes/'))
      .map((file) => PackIndexSchema.parse(JSON.parse(file.data!.toString('utf8'))));
    expect(indexes.map((index) => index.entries.length).sort((a, b) => a - b)).toEqual([1, 64]);
    const large = Buffer.alloc(16 * 1024 ** 2, 1),
      hash = sha256(large);
    const entries = [0, 1].map((i) => ({
      key: `objects/${'0'.repeat(64)}/chunk-0000${i}.ndjson.gz`,
      data: large,
      bytes: large.length,
      checksum: hash,
      rawBytes: 1,
    }));
    const split = await packPublication(entries, rows.slice(0, 1));
    expect(split.filter((file) => file.key.startsWith('pack-indexes/'))).toHaveLength(2);
    for (const file of split.filter((file) => file.key.startsWith('packs/')))
      expect((await publicationBytes(file)).equals(large)).toBe(true);
    await expect(
      packPublication([{ ...entries[0]!, bytes: large.length + 1 }], rows.slice(0, 1)),
    ).rejects.toThrow('range bound');
  });
});

it('rejects a symlinked source collection before reading legacy or packed input', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await publicationFixture(join(root, 'batch'));
    await rename(join(root, 'batch/objects'), join(root, 'moved'));
    await symlink(join(root, 'moved'), join(root, 'batch/objects'), 'dir');
    await expect(
      exportPublication(fixture.plan, [fixture], join(root, 'public'), undefined, true),
    ).rejects.toThrow('symlink');
  });
});

it('audits retained individual artifacts even when a valid packed copy also exists', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await publicationFixture(join(root, 'batch')),
      target = join(root, 'public');
    await exportPublication(fixture.plan, [fixture], target);
    await exportPublication(fixture.plan, [fixture], target, undefined, true);
    await rm(
      join(
        target,
        'objects',
        fixture.receipt.objectHash.slice(7),
        fixture.manifest.chunks[0]!.file,
      ),
    );
    await expect(publicationGraph(async (key) => readFile(join(target, key)))).rejects.toThrow(
      'ENOENT',
    );
  });
});
