import { expect, it } from 'vite-plus/test';
import { readFile, writeFile, lstat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { LeaguePartitionResultSchema } from '@fantasy/domain/spatial';
import { Measurements } from '@fantasy/api/tooling';
import { withReplayDirectory } from '@fantasy/api/testing';
import { leaguePublicationFixture } from '../../test-support/leagues.ts';
import { exportLeague } from './league-export.ts';
import { localPublicationGraph } from '../publication/publication-graph.ts';

it('keeps identical public bytes with one, two and four requested verifiers and two full passes', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await leaguePublicationFixture(join(root, 'input'), { size: 2 });
    let previous: [string, string][] | undefined;
    for (const verificationWorkers of [1, 2, 4]) {
      const target = join(root, `public-${verificationWorkers}`);
      const measurement = new Measurements();
      const result = await measurement.run(() =>
        exportLeague(
          fixture.plan,
          fixture.partitions,
          [...fixture.completed].reverse(),
          target,
          undefined,
          { verificationWorkers },
        ),
      );
      expect(result).toMatchObject({
        status: 'formal',
        planned: 4,
        resolved: 4,
        missingPartitions: [],
      });
      expect(measurement.report().validation).toMatchObject({
        calls: 8,
        uniqueReplays: 4,
        repeatedCalls: 4,
      });
      const graph = await localPublicationGraph(target);
      const entries = [...graph.files.values()].map((file): [string, string] => [
        file.key,
        file.checksum,
      ]);
      entries.sort(([a], [b]) => a.localeCompare(b));
      if (previous) expect(entries).toEqual(previous);
      previous = entries;
    }
  });
}, 30000);

it.each(['receipt', 'manifest', 'chunk', 'checkpoint'] as const)(
  'rechecks same-size %s bytes on every cached access and never carries success into a new session',
  async (kind) => {
    await withReplayDirectory(async (root) => {
      const fixture = await leaguePublicationFixture(join(root, 'input'));
      const entry = fixture.completed[0]!;
      const result = LeaguePartitionResultSchema.parse(entry.result);
      const receipt = result.index.slots.find((slot) => slot.receipt)!.receipt!;
      const manifest = await entry.bundles.manifest(receipt);
      const directory = join(entry.bundles.root, 'objects', receipt.objectHash.slice(7));
      const file =
        kind === 'receipt' || kind === 'manifest'
          ? `${kind}.json`
          : (kind === 'chunk' ? manifest.chunks : manifest.checkpoints)[0]!.file;
      const path = join(directory, file);
      const before = await readFile(path);
      const metadata = await lstat(path);
      const scope = entry.bundles.verificationSession();
      const measured = new Measurements();
      try {
        await measured.run(async () => {
          const first = await scope.verify(receipt.objectHash);
          first.resultHash = `sha256:${'0'.repeat(64)}`;
          expect(await scope.verify(receipt.objectHash)).toEqual(receipt);
        });
        expect(measured.report().validation.calls).toBe(1);
        const broken = Buffer.from(before);
        broken[0] = broken[0]! ^ 1;
        await writeFile(path, broken);
        await utimes(path, metadata.atime, metadata.mtime);
        expect((await lstat(path)).size).toBe(metadata.size);
        await expect(scope.verify(receipt.objectHash)).rejects.toMatchObject({
          code: 'DATA_INVALID',
        });
      } finally {
        scope.closeVerification();
        await writeFile(path, before);
      }
      await expect(scope.verify(receipt.objectHash)).rejects.toThrow('closed');
      const fresh = entry.bundles.verificationSession();
      try {
        await measured.run(() => fresh.verify(receipt.objectHash));
        expect(measured.report().validation.calls).toBe(2);
      } finally {
        fresh.closeVerification();
      }
    });
  },
  30000,
);

it('retains an independent Worker pass after the journal callback corrupts a checkpoint', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await leaguePublicationFixture(join(root, 'input'));
    const target = join(root, 'public');
    await exportLeague(fixture.plan, fixture.partitions, [], target);
    const pointer = join(target, 'catalog/current.json');
    const original = await readFile(pointer);
    const entry = fixture.completed[0]!;
    const result = LeaguePartitionResultSchema.parse(entry.result);
    const receipt = result.index.slots.find((slot) => slot.receipt)!.receipt!;
    const manifest = await entry.bundles.manifest(receipt);
    const path = join(
      entry.bundles.root,
      'objects',
      receipt.objectHash.slice(7),
      manifest.checkpoints[0]!.file,
    );
    await expect(
      exportLeague(
        fixture.plan,
        fixture.partitions,
        fixture.completed,
        target,
        async () => {
          await writeFile(path, Buffer.from('corrupt'));
          return { ref: { hash: `sha256:${'0'.repeat(64)}`, bytes: 2 }, files: [] };
        },
        { verificationWorkers: 2 },
      ),
    ).rejects.toMatchObject({ code: 'DATA_INVALID' });
    expect(await readFile(pointer)).toEqual(original);
  });
}, 30000);
