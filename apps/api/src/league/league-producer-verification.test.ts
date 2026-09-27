import { expect, it, vi } from 'vite-plus/test';
import { access, open } from 'node:fs/promises';
import { join } from 'node:path';
import { revisionReference, type LeagueDefinition } from '@fantasy/domain/spatial';
import { sealRevision } from '@fantasy/engine/spatial';
import { leagueInput, leagueEstimate } from '../../test-support/leagues.ts';
import { batchSource } from '../../test-support/batches.ts';
import { withReplayDirectory } from '../../test-support/replays.ts';
import { BattleBundles } from '../batch/battle-bundle.ts';
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
          const handle = await open(join(this.root, 'objects', hash.slice(7), filename), 'r+');
          try {
            const metadata = await handle.stat();
            const first = Buffer.alloc(1);
            await handle.read(first, 0, 1, 0);
            first[0] = first[0]! ^ 1;
            await handle.write(first, 0, 1, 0);
            await handle.utimes(metadata.atime, metadata.mtime);
            expect((await handle.stat()).size).toBe(metadata.size);
          } finally {
            await handle.close();
          }
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
    const input = await leagueInput();
    const character = input.revisions.find(
      (revision) => revision.kind === 'character' && revision.id === input.characters[0]!.id,
    );
    if (!character || character.kind !== 'character') throw new Error('Missing fixture character');
    const privateName = await sealRevision('character', character.id, character.revision, {
      ...character.definition,
      name: '/private/profile',
    });
    input.revisions = input.revisions.map((revision) =>
      revision === character ? privateName : revision,
    );
    input.characters[0] = revisionReference(privateName);
    const run = await producer(root, input);
    await expect(run()).rejects.toMatchObject({
      code: 'DATA_INVALID',
      message: 'Private text is not publishable',
    });
    await expect(access(join(root, 'results'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
}, 30_000);
