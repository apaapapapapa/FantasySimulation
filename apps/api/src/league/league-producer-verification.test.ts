import { expect, it, vi } from 'vite-plus/test';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type LeagueDefinition } from '@fantasy/domain/spatial';
import { leagueInput, leagueEstimate, privateLeagueInput } from '../../test-support/leagues.ts';
import { batchSource } from '../../test-support/batches.ts';
import { flipFirstByte, withReplayDirectory } from '../../test-support/replays.ts';
import { BattleBundles } from '../batch/battle-bundle.ts';
import { PrivateDataError } from '../replay/replay-public.ts';
import { planLeague } from './league-plan.ts';
import { reserveLeaguePartition, runLeaguePartition } from './league-runner.ts';

async function producer(root: string, input?: LeagueDefinition) {
  const { plan, partitions } = await planLeague(
    input ?? (await leagueInput()),
    batchSource,
    leagueEstimate,
  );
  const { partition, batch } = partitions[0]!;
  const reservation = await reserveLeaguePartition(plan, partition, [], 'producer-scope');
  return () =>
    runLeaguePartition(plan, partition, batch, reservation, root, batchSource, 'producer-scope');
}

it.each(['receipt', 'manifest', 'chunk', 'checkpoint'] as const)(
  'refuses a partition after its verified %s changes without changing size or mtime',
  async (kind) => {
    await withReplayDirectory(async (root) => {
      const run = await producer(root);
      const session = vi.spyOn(BattleBundles.prototype, 'verificationSession');
      const originalVerify = BattleBundles.prototype.verify;
      let changedHash: string | undefined;
      const verify = vi.spyOn(BattleBundles.prototype, 'verify').mockImplementation(async function (
        this: BattleBundles,
        hash: string,
      ) {
        const receipt = await originalVerify.call(this, hash);
        // Mutate only after the producer's first real semantic/privacy pass succeeded.
        if (!changedHash && this === session.mock.results[0]?.value) {
          const manifest = await this.manifest(receipt);
          const filename =
            kind === 'receipt' || kind === 'manifest'
              ? `${kind}.json`
              : (kind === 'chunk' ? manifest.chunks : manifest.checkpoints)[0]!.file;
          await flipFirstByte(join(this.root, 'objects', hash.slice(7), filename));
          changedHash = hash;
        }
        return receipt;
      });
      try {
        await expect(run()).rejects.toMatchObject({ code: 'DATA_INVALID' });
        expect(changedHash).toBeDefined();
        await expect(access(join(root, 'results'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(session).toHaveBeenCalledTimes(1);
        const scope = session.mock.results[0]!.value as BattleBundles;
        await expect(originalVerify.call(scope, changedHash!)).rejects.toThrow('closed');
      } finally {
        verify.mockRestore();
        session.mockRestore();
      }
    });
  },
  30_000,
);

it('checks publishability in the producer before issuing a partition result', async () => {
  await withReplayDirectory(async (root) => {
    const run = await producer(root, await privateLeagueInput());
    const refused = run();
    await expect(refused).rejects.toBeInstanceOf(PrivateDataError);
    await expect(refused).rejects.toMatchObject({
      code: 'DATA_INVALID',
      message: 'Private text is not publishable',
    });
    await expect(access(join(root, 'results'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Public staging refuses the batch itself: no index records a failed slot to retry later.
    expect(await readdir(join(root, 'bundles', 'indexes'))).toEqual([]);
  });
}, 30_000);
