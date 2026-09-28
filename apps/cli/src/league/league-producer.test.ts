import { expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import { LeaguePartitionResultSchema } from '@fantasy/domain/spatial';
import { BattleBundles } from '@fantasy/api/artifacts';
import { flipFirstByte, withReplayDirectory } from '@fantasy/api/testing';
import { Measurements } from '@fantasy/api/tooling';
import { preparedPipeline } from '../../test-support/league-pipeline.ts';
import { cloudJson } from './league-cloud-files.ts';
import { runCloudLeagueRunner } from './league-runner.ts';
import { sealLeagueProducer } from './league-producer.ts';

it('seals from the partition scope without decoding again and with identical output', async () => {
  await withReplayDirectory(async (root) => {
    const { identity, executionId, preparedRoot, input } = await preparedPipeline(root);
    const fresh = new Measurements(),
      scoped = new Measurements();
    const proofs: unknown[] = [];
    await runCloudLeagueRunner(preparedRoot, join(root, 'results'), identity.source, executionId, {
      runner: 0,
      runners: 1,
      workers: 1,
      completed: async (_, directory, pool, bundles) => {
        const seal = (target: string, scope?: BattleBundles) =>
          sealLeagueProducer(input, directory, join(root, target), identity, 0, pool, scope);
        proofs.push(await fresh.run(() => seal('fresh')));
        proofs.push(await scoped.run(() => seal('scoped', bundles)));
      },
    });
    expect(proofs).toHaveLength(2);
    expect(proofs[1]).toEqual(proofs[0]);
    // A fresh public scope decodes all four recordings again. The producer's own scope already
    // decoded them during computation, so its seal only re-hashes their bytes.
    expect(fresh.report().validation).toMatchObject({ calls: 4, uniqueReplays: 4 });
    expect(scoped.report().validation.calls).toBe(0);
  });
}, 60000);

it('refuses foreign scopes and re-hashes a recording changed after computation', async () => {
  await withReplayDirectory(async (root) => {
    const { identity, executionId, preparedRoot, input } = await preparedPipeline(root);
    let changed = false;
    const run = runCloudLeagueRunner(
      preparedRoot,
      join(root, 'results'),
      identity.source,
      executionId,
      {
        runner: 0,
        runners: 1,
        workers: 1,
        completed: async (_, directory, pool, bundles) => {
          const producer = join(root, 'producer');
          for (const [scope, verifier] of [
            [
              new BattleBundles(join(root, 'other')).verificationSession({
                publicData: true,
                pool,
              }),
              pool,
            ],
            [new BattleBundles(bundles.root).verificationSession({ pool }), pool],
            [bundles, undefined],
          ] as const)
            await expect(
              sealLeagueProducer(input, directory, producer, identity, 0, verifier, scope),
            ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
          const result = LeaguePartitionResultSchema.parse(
            await cloudJson(join(directory, 'result.json')),
          );
          const receipt = result.index.slots.find((slot) => slot.receipt)!.receipt!;
          const manifest = await bundles.manifest(receipt);
          await flipFirstByte(
            join(bundles.root, 'objects', receipt.objectHash.slice(7), manifest.chunks[0]!.file),
          );
          changed = true;
          await sealLeagueProducer(input, directory, producer, identity, 0, pool, bundles);
        },
      },
    );
    await expect(run).rejects.toMatchObject({ code: 'DATA_INVALID' });
    expect(changed).toBe(true);
  });
}, 60000);
