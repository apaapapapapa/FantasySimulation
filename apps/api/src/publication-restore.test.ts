import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vite-plus/test';
import { publicationFixture } from '../test-support/publication.ts';
import { exportPublication } from './publication-export.ts';
import { localPublicationGraph } from './publication-graph.ts';
import { restorePublication } from './publication-restore.ts';
import type { PublicationStore } from './publication-remote.ts';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function snapshot() {
  const parent = await mkdtemp(join(tmpdir(), 'restore-'));
  directories.push(parent);
  const fixture = await publicationFixture(join(parent, 'batch'));
  const original = join(parent, 'published');
  await exportPublication(fixture.plan, [fixture], original);
  const requests: string[] = [];
  const reader: Pick<PublicationStore, 'read'> = {
    async read(key) {
      requests.push(key);
      try {
        return { data: await readFile(join(original, key)), etag: 'unchanged' };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  };
  return { parent, original, fixture, reader, requests, restored: join(parent, 'runner') };
}

it('recovers exact bytes on a fresh runner, reuses a set, and retains the prior generation', async () => {
  const { parent, original, fixture, reader, restored, requests } = await snapshot();
  const before = await localPublicationGraph(original);
  const result = await restorePublication(restored, reader);
  expect(result).toMatchObject({
    status: 'restored',
    catalogHash: before.current.catalogHash,
    files: before.files.size,
  });
  for (const key of before.files.keys())
    expect(await readFile(join(restored, key))).toEqual(await readFile(join(original, key)));
  expect(requests.filter((key) => key === 'catalog/current.json')).toHaveLength(2);
  expect(result.downloadBytes).toBeGreaterThan(before.totalBytes);
  await exportPublication(fixture.plan, [fixture], restored);
  expect((await localPublicationGraph(restored)).current).toEqual(before.current);
  const next = await publicationFixture(join(parent, 'next'), 'complete', 321);
  await exportPublication(next.plan, [next], restored);
  const after = await localPublicationGraph(restored);
  expect(after.catalog.previousCatalogHash).toBe(before.current.catalogHash);
  expect(after.catalog.sets).toHaveLength(2);
  for (const key of before.files.keys()) expect(after.files.has(key)).toBe(true);
  expect((await localPublicationGraph(original)).current).toEqual(before.current);
});

it('creates an empty first-publication directory without requiring existing objects', async () => {
  const { restored } = await snapshot();
  const result = await restorePublication(restored, { read: async () => null });
  expect(result).toEqual({ status: 'empty', files: 0, downloadBytes: 0, reads: 2 });
  expect((await stat(restored)).isDirectory()).toBe(true);
});

it('rejects a concurrent first publication instead of reporting an empty restore', async () => {
  const { original, restored, reader } = await snapshot();
  let calls = 0;
  await expect(
    restorePublication(restored, {
      read: async (key, limit) => (++calls === 1 ? null : reader.read(key, limit)),
    }),
  ).rejects.toThrow('generation changed');
  expect(calls).toBe(2);
  await expect(stat(restored)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await stat(original)).isDirectory()).toBe(true);
});

it.each(['directory', 'symlink'] as const)('never overwrites an existing %s', async (kind) => {
  const { parent, original, reader, requests } = await snapshot();
  const pointer = await readFile(join(original, 'catalog/current.json'));
  const destination = kind === 'directory' ? original : join(parent, 'link');
  if (kind === 'symlink') await symlink(original, destination);
  await expect(restorePublication(destination, reader)).rejects.toThrow();
  expect(requests).toEqual([]);
  expect(await readFile(join(original, 'catalog/current.json'))).toEqual(pointer);
});

it.each(['missing', 'corrupt', 'capacity', 'generation', 'transport'] as const)(
  'removes only its own incomplete restore after a %s failure',
  async (failure) => {
    const { original, restored, reader } = await snapshot();
    const read = reader.read.bind(reader);
    let pointers = 0;
    reader.read = async (key, limit) => {
      if (failure === 'transport') throw new Error('unavailable');
      const value = await read(key, limit);
      if (key === 'catalog/current.json') pointers++;
      if (failure === 'generation' && pointers === 2 && value)
        return { ...value, etag: 'concurrent-writer' };
      if (key.endsWith('.gz')) {
        if (failure === 'missing') return null;
        if (failure === 'corrupt' && value) {
          const data = Buffer.from(value.data);
          data[0] = data[0]! ^ 1;
          return { ...value, data };
        }
      }
      return value;
    };
    await expect(
      restorePublication(restored, reader, failure === 'capacity' ? 1 : undefined),
    ).rejects.toThrow();
    await expect(stat(restored)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(original)).isDirectory()).toBe(true);
    reader.read = read;
    expect((await restorePublication(restored, reader)).status).toBe('restored');
  },
);

it.each([0, -1, 1.5, Number.NaN, 8_000_000_001])(
  'refuses an invalid restore budget %s before accessing storage',
  async (budget) => {
    const { restored, reader, requests } = await snapshot();
    await expect(restorePublication(restored, reader, budget)).rejects.toThrow('Invalid');
    expect(requests).toEqual([]);
    await expect(stat(restored)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
