import { join } from 'node:path';
import { cp } from 'node:fs/promises';
import { leagueFixture } from '@fantasy/samples/testing';
import { publicationLeagueSource } from './leagues.ts';
import { prepareCloudLeague } from '../src/league/league-cloud.ts';
import { cloudInput } from '../src/league/league-cloud-files.ts';
import { runCloudLeagueRunner } from '../src/league/league-runner.ts';
import { sealLeagueProducer, authenticateLeagueProducer } from '../src/league/league-producer.ts';
import { PublicationEvidence } from '../src/publication/publication-evidence.ts';

/** One prepared four-slot partition, before any runner has claimed it. */
export async function preparedPipeline(root: string, characters = 2) {
  const identity = {
    source: publicationLeagueSource,
    runId: 123,
    runAttempt: 1,
    validatorDigest: 'sha256:' + 'b'.repeat(64),
  };
  const executionId = 'league-123-1',
    preparedRoot = join(root, 'prepared'),
    baselineRoot = join(root, 'baseline');
  const { prepared } = await prepareCloudLeague(
    await leagueFixture(characters, 1),
    identity.source,
    executionId,
    baselineRoot,
    preparedRoot,
    { files: 0, bytes: 0, receipts: 0, usedReadRequests: 10000, usedWriteRequests: 10000 },
  );
  const input = await cloudInput(preparedRoot, prepared, 0);
  return { identity, executionId, prepared, preparedRoot, baselineRoot, input };
}

export async function pipelineFixture(root: string) {
  const { identity, executionId, prepared, preparedRoot, baselineRoot, input } =
    await preparedPipeline(root);
  const baseline = await PublicationEvidence.audit(baselineRoot);
  const resultRoot = join(root, 'results'),
    producerRoot = join(root, 'producer');
  await runCloudLeagueRunner(preparedRoot, resultRoot, identity.source, executionId, {
    runner: 0,
    runners: 1,
    workers: 1,
    completed: async (_, directory, pool, bundles) => {
      await sealLeagueProducer(input, directory, producerRoot, identity, 0, pool, bundles);
    },
  });
  const producer = await authenticateLeagueProducer(producerRoot, input, identity, 0, async () => [
    {
      id: 456,
      digest: 'sha256:' + 'c'.repeat(64),
      bytes: 128,
      name: 'league-123-1-runner-0-partition-0-part-0-of-1',
    },
  ]);
  const fullRoot = join(root, 'full');
  await cp(baselineRoot, fullRoot, { recursive: true });
  const terminal = {
    schemaVersion: 1,
    identity,
    runner: 0,
    partitions: [0],
    artifacts: producer.artifacts,
  };
  return {
    identity,
    executionId,
    prepared,
    preparedRoot,
    baseline,
    resultRoot,
    producerRoot,
    input,
    producer,
    fullRoot,
    terminal,
  };
}

/** Real bounded 144-match/2-partition fixture, sealed before transport timers start. */
export async function sealedTwoPartitionFixture(root: string) {
  const fixture = await preparedPipeline(root, 9);
  const baseline = await PublicationEvidence.audit(fixture.baselineRoot);
  const sealed: { root: string; proof: Awaited<ReturnType<typeof sealLeagueProducer>> }[] = [];
  await runCloudLeagueRunner(
    fixture.preparedRoot,
    join(root, 'results'),
    fixture.identity.source,
    fixture.executionId,
    {
      runner: 0,
      runners: 1,
      workers: 2,
      completed: async (index, directory, pool, bundles) => {
        const producerRoot = join(root, 'sealed', String(index));
        const proof = await sealLeagueProducer(
          await cloudInput(fixture.preparedRoot, fixture.prepared, index),
          directory,
          producerRoot,
          fixture.identity,
          0,
          pool,
          bundles,
        );
        sealed.push({ root: producerRoot, proof });
      },
    },
  );
  if (sealed.length !== 2 || sealed.some((value, index) => value.proof.partition !== index))
    throw new Error('Expected real two-partition fixture');
  return { ...fixture, baseline, sealed };
}
