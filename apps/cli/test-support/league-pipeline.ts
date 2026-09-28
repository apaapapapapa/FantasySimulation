import { join } from 'node:path';
import { cp } from 'node:fs/promises';
import { leagueFixture } from '@fantasy/samples/testing';
import { publicationLeagueSource } from './leagues.ts';
import { prepareCloudLeague } from '../src/league/league-cloud.ts';
import { cloudInput } from '../src/league/league-cloud-files.ts';
import { runCloudLeagueRunner } from '../src/league/league-runner.ts';
import { sealLeagueProducer, authenticateLeagueProducer } from '../src/league/league-producer.ts';
import { PublicationEvidence } from '../src/publication/publication-evidence.ts';

export async function pipelineFixture(root: string) {
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
    await leagueFixture(2, 1),
    identity.source,
    executionId,
    baselineRoot,
    preparedRoot,
    { files: 0, bytes: 0, receipts: 0, usedReadRequests: 10000, usedWriteRequests: 10000 },
  );
  const baseline = await PublicationEvidence.audit(baselineRoot);
  const resultRoot = join(root, 'results'),
    producerRoot = join(root, 'producer');
  const input = await cloudInput(preparedRoot, prepared, 0);
  await runCloudLeagueRunner(preparedRoot, resultRoot, identity.source, executionId, {
    runner: 0,
    runners: 1,
    workers: 1,
    completed: async (_, directory, pool) => {
      await sealLeagueProducer(input, directory, producerRoot, identity, 0, pool);
    },
  });
  const producer = await authenticateLeagueProducer(
    producerRoot,
    input,
    identity,
    0,
    async () => {},
  );
  const fullRoot = join(root, 'full');
  await cp(baselineRoot, fullRoot, { recursive: true });
  const terminal = { schemaVersion: 1, identity, runner: 0, partitions: [0], artifacts: [] };
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
