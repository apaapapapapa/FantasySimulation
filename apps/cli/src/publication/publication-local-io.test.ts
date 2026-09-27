import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { BattleBundles, readBoundedFile } from '@fantasy/api/artifacts';
import { withReplayDirectory } from '@fantasy/api/testing';
import { leaguePublicationFixture } from '../../test-support/leagues.ts';
import { exportLeague } from '../league/league-export.ts';
import { localPublicationGraph, publicationGraph } from './publication-graph.ts';
import { PublicationIo } from './publication-io.ts';
import { restorePublication } from './publication-restore.ts';

afterEach(() => vi.restoreAllMocks());

async function publicationAt(root: string) {
  const fixture = await leaguePublicationFixture(join(root, 'batch'));
  const directory = join(root, 'public');
  await exportLeague(fixture.plan, fixture.partitions, fixture.completed, directory);
  return directory;
}

function tracedReader(directory: string, fail = false) {
  const state = { active: 0, peak: 0 };
  const read = async (key: string, limit: number) => {
    state.peak = Math.max(state.peak, ++state.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, key.endsWith('/receipt.json') ? 3 : 1));
      if (fail && key.endsWith('/receipt.json')) throw new Error('interrupted graph read');
      return await readBoundedFile(join(directory, key), limit);
    } finally {
      state.active--;
    }
  };
  return { state, read };
}

it('keeps graph order and full semantic verification independent of local I/O width', async () => {
  await withReplayDirectory(async (root) => {
    const directory = await publicationAt(root);
    const verify = vi.spyOn(BattleBundles.prototype, 'verify');
    const serial = await localPublicationGraph(directory, 1, undefined, 1);
    expect(serial.objects.size).toBeGreaterThan(1);
    expect(verify).toHaveBeenCalledTimes(serial.objects.size);
    verify.mockClear();
    const parallel = await localPublicationGraph(directory, 1, undefined, 4);
    expect(verify).toHaveBeenCalledTimes(serial.objects.size);
    expect(parallel).toEqual(serial);
    expect([...parallel.files.keys()]).toEqual([...serial.files.keys()]);
    expect([...parallel.objects]).toEqual([...serial.objects]);
  });
});

it('overlaps bounded graph I/O while keeping all returned references and ordering identical', async () => {
  await withReplayDirectory(async (root) => {
    const directory = await publicationAt(root);
    const serial = tracedReader(directory);
    const expected = await publicationGraph(serial.read, 1);
    expect(serial.state.peak).toBe(1);
    const parallel = tracedReader(directory);
    const actual = await publicationGraph(parallel.read, 4);
    expect(parallel.state.peak).toBeGreaterThan(1);
    expect(parallel.state.peak).toBeLessThanOrEqual(4);
    expect(parallel.state.active).toBe(0);
    expect(actual).toEqual(expected);
    expect([...actual.files.keys()]).toEqual([...expected.files.keys()]);
    expect([...actual.results]).toEqual([...expected.results]);
  });
});

it('drains admitted graph readers before reporting a failed traversal', async () => {
  await withReplayDirectory(async (root) => {
    const directory = await publicationAt(root);
    const interrupted = tracedReader(directory, true);
    await expect(publicationGraph(interrupted.read, 4)).rejects.toThrow('interrupted graph read');
    expect(interrupted.state.active).toBe(0);
  });
});

it('does not produce discarded file buffers during restore prefetch', async () => {
  await withReplayDirectory(async (root) => {
    const directory = await publicationAt(root);
    const before = await localPublicationGraph(directory);
    const io = vi.spyOn(PublicationIo.prototype, 'run');
    const restored = join(root, 'restored');
    const outcome = await restorePublication(
      restored,
      {
        read: async (key) => ({
          data: await readFile(join(directory, key)),
          etag: 'unchanged-fixture',
        }),
      },
      undefined,
      4,
    );
    const values: unknown[] = await Promise.all(io.mock.results.map((result) => result.value));
    // Only actual graph consumers read buffers; prefetch persists and returns void.
    expect(values.filter(Buffer.isBuffer)).toHaveLength(before.files.size);
    expect(outcome.files).toBe(before.files.size);
    expect(outcome.reads).toBe(before.files.size + 1);
    expect((await localPublicationGraph(restored)).current).toEqual(before.current);
  });
});

it.each([0, 65, 1.5, Number.NaN])(
  'rejects invalid graph I/O width %s before accessing the directory',
  async (width) => {
    await expect(localPublicationGraph('/not-a-publication', 1, undefined, width)).rejects.toThrow(
      'Invalid',
    );
  },
);
