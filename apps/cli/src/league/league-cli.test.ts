import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { withReplayDirectory } from '@fantasy/api/testing';

const originalArgv = process.argv,
  originalExitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

it.each(['check', 'export'])(
  'reads saved results through the real league %s entry after an installed-engine change',
  async (command) => {
    const { leaguePublicationFixture } = await import('../../test-support/leagues.ts');
    const { implementation, ManifestBuilder } = await import('@fantasy/engine/spatial');
    const { canonicalJson } = await import('@fantasy/domain/spatial');
    await withReplayDirectory(async (root) => {
      const results = join(root, 'results'),
        input = join(root, 'plan'),
        published = join(root, 'public'),
        fixture = await leaguePublicationFixture(results);
      const documents: Array<readonly [string, unknown]> = [
        ['league.json', fixture.plan],
        ...fixture.partitions.flatMap(
          ({ partition, batch }) =>
            [
              [`partitions/${partition.id.slice(7)}.json`, partition],
              [`batches/${batch.id.slice(7)}.json`, batch],
            ] as const,
        ),
      ];
      for (const [path, data] of documents) {
        const target = join(input, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, canonicalJson(data));
      }
      const digest = implementation.digest,
        build = vi.spyOn(ManifestBuilder.prototype, 'build');
      try {
        // Change only the installed test engine; saved plans and recordings remain intact.
        implementation.digest = 'sha256:' + 'f'.repeat(64);
        process.argv = ['node', 'league.ts', command, input, results];
        if (command === 'export') process.argv.push(published);
        await import('../league.ts');
        expect(process.exitCode ?? 0).toBe(0);
        expect(console.error).not.toHaveBeenCalled();
        expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toMatchObject({
          status: 'formal',
          planned: 4,
          resolved: 4,
          missingPartitions: [],
        });
        expect(build).not.toHaveBeenCalled();
        if (command === 'export') {
          const { localPublicationGraph } = await import('../publication/publication-graph.ts');
          expect((await localPublicationGraph(published)).catalog.leagues).toHaveLength(1);
        }
      } finally {
        implementation.digest = digest;
      }
    });
  },
  30000,
);
