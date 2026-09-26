import { expect, it, vi } from 'vite-plus/test';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { withReplayDirectory } from '@fantasy/api/testing';
import { BattleBundles } from '@fantasy/api/artifacts';
import { leagueFixture } from '@fantasy/samples/testing';
import { leagueSlotCount, LeagueDefinitionSchema } from '@fantasy/domain/spatial';
import { publicationLeagueSource as source } from '../../test-support/leagues.ts';
import { prepareCloudLeague, runCloudLeague, finishCloudLeague } from './league-cloud.ts';
import { preparedLeague, cloudInput, writeCloudJson } from './league-cloud-files.ts';
import { PublicReadFailure } from '../publication/publication-http.ts';
import { probeLeague } from './league-probe.ts';
import { leagueArtifactFiles } from './league-artifact-files.ts';

const inventory = {
  files: 0,
  bytes: 0,
  receipts: 0,
  usedReadRequests: 10000,
  usedWriteRequests: 10000,
};
const reader = (root: string) => async (key: string) => readFile(join(root, key));
it('resumes a missing worker once, verifies results, skips unchanged input and reuses pairs for a new participant', async () => {
  await withReplayDirectory(async (root) => {
    const definition = await leagueFixture(2, 1),
      publicRoot = join(root, 'public');
    const first = join(root, 'first'),
      second = join(root, 'second');
    await prepareCloudLeague(definition, source, 'first', publicRoot, first, inventory);
    expect(
      await finishCloudLeague(first, join(root, 'absent'), publicRoot, source, 'first'),
    ).toMatchObject({ status: 'provisional', planned: 4, resolved: 0 });
    expect(await probeLeague(definition, source.sha, reader(publicRoot))).toMatchObject({
      needed: true,
      estimate: { retries: 4, compute: 4 },
    });
    await prepareCloudLeague(definition, source, 'second', publicRoot, second, inventory);
    const prepared = await preparedLeague(second),
      input = await cloudInput(second, prepared, 0);
    expect(input.reservation.progress.records.map((r) => r.attempts.length)).toEqual([2, 2, 2, 2]);
    await expect(
      runCloudLeague(
        join(second, 'inputs/0'),
        join(root, 'forged'),
        { ...source, sha: 'e'.repeat(40) },
        'second',
      ),
    ).rejects.toThrow('source/execution mismatch');
    await expect(
      runCloudLeague(join(second, 'inputs/0'), join(root, 'rerun'), source, 'second-rerun'),
    ).rejects.toThrow('source/execution mismatch');
    const output = join(root, 'results/0');
    await runCloudLeague(join(second, 'inputs/0'), output, source, 'second');
    const selection = await leagueArtifactFiles(output, 'result');
    expect(selection.files).toContain(join(output, 'result.json'));
    expect(selection.files.some((path) => /\/(?:\.work|complete|indexes|plans)\//.test(path))).toBe(
      false,
    );
    // Publication recovery must keep the original data identity, even on newer tooling.
    for (const [candidate, execution] of [
      [{ ...source, sha: 'e'.repeat(40) }, 'second'],
      [source, 'new-publication-run'],
    ] as const)
      await expect(
        finishCloudLeague(second, join(root, 'results'), publicRoot, candidate, execution),
      ).rejects.toThrow('finalizer identity');
    const verification = vi.spyOn(BattleBundles.prototype, 'verify');
    try {
      expect(
        await finishCloudLeague(second, join(root, 'results'), publicRoot, source, 'second'),
      ).toMatchObject({ status: 'formal', planned: 4, resolved: 4 });
      // Each result has three binding checks, then one independent export check.
      // Journal packing must not run the complete result check a second time.
      expect(
        verification.mock.calls.filter((_, index) => {
          const context = verification.mock.contexts[index];
          return context instanceof BattleBundles && context.root === join(output, 'bundles');
        }),
      ).toHaveLength(16);
    } finally {
      verification.mockRestore();
    }
    expect(await probeLeague(definition, 'b'.repeat(40), reader(publicRoot))).toMatchObject({
      needed: false,
      estimate: { reused: 4, compute: 0 },
    });
    expect(
      await probeLeague(await leagueFixture(3, 1), source.sha, reader(publicRoot)),
    ).toMatchObject({ needed: true, estimate: { planned: 12, reused: 4, newMatches: 8 } });
  });
}, 30000);
it('publishes exhausted missing slots with their denominator and never admits a third attempt', async () => {
  await withReplayDirectory(async (root) => {
    const definition = await leagueFixture(2, 1),
      publicRoot = join(root, 'public');
    for (const id of ['one', 'two']) {
      await prepareCloudLeague(definition, source, id, publicRoot, join(root, id), inventory);
      await finishCloudLeague(join(root, id), join(root, 'missing'), publicRoot, source, id);
    }
    expect(await probeLeague(definition, source.sha, reader(publicRoot))).toMatchObject({
      needed: false,
      estimate: { planned: 4, exhausted: 4, compute: 0 },
    });
    await prepareCloudLeague(
      definition,
      source,
      'three',
      publicRoot,
      join(root, 'three'),
      inventory,
    );
    const prepared = await preparedLeague(join(root, 'three'));
    const input = await cloudInput(join(root, 'three'), prepared, 0);
    expect(
      input.reservation.progress.records.every(
        (r) => r.attempts.length === 2 && r.attempts.at(-1)!.executionId === 'two',
      ),
    ).toBe(true);
  });
}, 30000);
it('fails closed on corrupt metadata and artifact symlinks, while empty storage requires work', async () => {
  const definition = await leagueFixture(2, 1);
  expect(
    await probeLeague(definition, source.sha, async () => {
      throw new PublicReadFailure(404);
    }),
  ).toMatchObject({ needed: true, requests: 1 });
  await expect(
    probeLeague(definition, source.sha, async () => {
      throw new PublicReadFailure(500);
    }),
  ).rejects.toThrow('500');
  await withReplayDirectory(async (root) => {
    const publicRoot = join(root, 'public');
    await prepareCloudLeague(
      definition,
      source,
      'corruption',
      publicRoot,
      join(root, 'prepared'),
      inventory,
    );
    await expect(
      probeLeague(definition, source.sha, async (key) =>
        key.startsWith('leagues/') ? Buffer.from('{}') : readFile(join(publicRoot, key)),
      ),
    ).rejects.toThrow('checksum');
    const inputRoot = join(root, 'input');
    await mkdir(inputRoot);
    await writeCloudJson(join(inputRoot, 'input.json'), {});
    await mkdir(join(inputRoot, 'retained'));
    await mkdir(join(root, 'private'));
    await writeFile(join(root, 'private/file'), 'private');
    await symlink(join(root, 'private'), join(inputRoot, 'retained/objects'));
    await expect(leagueArtifactFiles(inputRoot, 'input')).rejects.toThrow('symlink');
  });
});
it('commits the complete twenty-character, five-field, swapped four-trial league', async () => {
  const official = LeagueDefinitionSchema.parse(
    JSON.parse(
      await readFile(
        new URL('../../../../data/leagues/official-20-v1.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  expect(official.characters).toHaveLength(20);
  expect(official.battlefields.map((field) => field.weight)).toEqual(
    Array(5).fill({ numerator: '1', denominator: '5' }),
  );
  expect(official.ruleset.id).toBe('standard-tactics-v2');
  expect(leagueSlotCount(official)).toBe(7600);
});
