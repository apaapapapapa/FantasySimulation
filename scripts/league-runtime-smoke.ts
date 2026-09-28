import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionSource } from '@fantasy/api/tooling';
import { leagueFixture } from '@fantasy/samples/testing';
import { prepareCloudLeague } from '../apps/cli/src/league/league-cloud.ts';
import { cloudInput } from '../apps/cli/src/league/league-cloud-files.ts';
import { runCloudLeagueRunner } from '../apps/cli/src/league/league-runner.ts';
import { sealLeagueProducer } from '../apps/cli/src/league/league-producer.ts';
import { leagueValidatorDigest } from '../apps/cli/src/league/league-validator.ts';

const root = await mkdtemp(join(tmpdir(), 'league-runtime-smoke-'));
const started = performance.now();
try {
  // Exercise the artifact SDK's generated RPC imports in the dependency-only installation.
  await import('./league-pipeline-upload.ts');
  await import('./league-pipeline-transfer.ts');
  const source = executionSource();
  const identity = {
    source,
    runId: 1,
    runAttempt: 1,
    validatorDigest: await leagueValidatorDigest(process.cwd()),
  };
  const preparedRoot = join(root, 'prepared');
  const { prepared } = await prepareCloudLeague(
    await leagueFixture(2, 1),
    source,
    'league-1-1',
    join(root, 'public'),
    preparedRoot,
    { files: 0, bytes: 0, receipts: 0, usedReadRequests: 10000, usedWriteRequests: 10000 },
  );
  await runCloudLeagueRunner(preparedRoot, join(root, 'results'), source, 'league-1-1', {
    runner: 0,
    runners: 1,
    workers: 1,
    completed: async (index, directory, pool) => {
      await sealLeagueProducer(
        await cloudInput(preparedRoot, prepared, index),
        directory,
        join(root, 'producer'),
        identity,
        0,
        pool,
      );
    },
  });
  console.log(
    JSON.stringify({
      runtimeSmoke: 'simulation-native-db-independent-verifier-pack',
      elapsedMs: performance.now() - started,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
