import { expect, it, vi } from 'vite-plus/test';
import { cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withReplayDirectory } from '@fantasy/api/testing';
import { validateLeaguePlan } from '@fantasy/api/tooling';
import { implementation, ManifestBuilder } from '@fantasy/engine/spatial';
import { leagueFixture } from '@fantasy/samples/testing';
import { publicationLeagueSource as source } from '../../test-support/leagues.ts';
import { prepareCloudLeague, runCloudLeague, finishCloudLeague } from './league-cloud.ts';
import { preparedLeague } from './league-cloud-files.ts';
import { localPublicationGraph } from '../publication/publication-graph.ts';

it('recovers the same saved catalog after an installed-engine change without preparing or running old battles', async () => {
  await withReplayDirectory(async (root) => {
    const preparedRoot = join(root, 'prepared'),
      recoveryInput = join(root, 'recovery-input'),
      results = join(root, 'results'),
      published = join(root, 'published'),
      recovered = join(root, 'recovered');
    await prepareCloudLeague(
      await leagueFixture(2, 1),
      source,
      'saved-run',
      published,
      preparedRoot,
      {
        files: 0,
        bytes: 0,
        receipts: 0,
        usedReadRequests: 0,
        usedWriteRequests: 0,
      },
    );
    await runCloudLeague(join(preparedRoot, 'inputs/0'), join(results, '0'), source, 'saved-run');
    await cp(published, recovered, { recursive: true });
    await cp(preparedRoot, recoveryInput, { recursive: true });
    const original = await finishCloudLeague(preparedRoot, results, published, source, 'saved-run');
    expect(original).toMatchObject({
      status: 'formal',
      planned: 4,
      resolved: 4,
      missingPartitions: [],
    });
    const saved = await preparedLeague(preparedRoot),
      digest = implementation.digest,
      build = vi.spyOn(ManifestBuilder.prototype, 'build');
    try {
      // Test-only installed-engine transition. Saved identities and recording bytes stay untouched.
      implementation.digest = 'sha256:' + 'f'.repeat(64);
      await expect(validateLeaguePlan(saved.plan)).rejects.toThrow('execution identity');
      await expect(
        runCloudLeague(
          join(preparedRoot, 'inputs/0'),
          join(root, 'forbidden-run'),
          source,
          'saved-run',
        ),
      ).rejects.toThrow('execution identity');
      expect(
        await finishCloudLeague(recoveryInput, results, recovered, source, 'saved-run'),
      ).toEqual(original);
      expect(build).not.toHaveBeenCalled();
      expect(await readFile(join(recovered, 'catalog/current.json'))).toEqual(
        await readFile(join(published, 'catalog/current.json')),
      );
      expect((await localPublicationGraph(recovered)).catalog).toEqual(
        (await localPublicationGraph(published)).catalog,
      );
    } finally {
      implementation.digest = digest;
      build.mockRestore();
    }
  });
}, 30000);
