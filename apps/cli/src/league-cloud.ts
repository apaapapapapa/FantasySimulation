import { appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionSource, OperationError, operationInput } from '@fantasy/api/tooling';
import { probeLeague } from './league/league-probe.ts';
import { prepareCloudLeague, runCloudLeague, finishCloudLeague } from './league/league-cloud.ts';
import { cloudJson, writeCloudJson } from './league/league-cloud-files.ts';
import { transferCloudLeague } from './league/league-transfer.ts';
import { publicHttp, ancestorOf } from './publication/publication-http.ts';

import { reportLeagueFailure, type LeagueFailureContext } from './league/league-diagnostics.ts';

const failureContext: LeagueFailureContext = { validating: true };
let reportRoot: string | undefined;
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new OperationError('INPUT_INVALID', `Missing ${name}`);
  return value;
};
async function main() {
  const [command, directory, input] = process.argv.slice(2);
  failureContext.command = command ?? 'unknown';
  if (directory) reportRoot = resolve(directory);
  if (
    !directory ||
    !['probe', 'restore', 'prepare', 'admit', 'run', 'finish', 'publish'].includes(command ?? '')
  )
    throw new OperationError('INPUT_INVALID', 'Invalid league cloud command');
  const root = resolve(directory);
  const executionId = `league-${required('GITHUB_RUN_ID')}-${required('GITHUB_RUN_ATTEMPT')}`;
  if (executionId.match(/^league-[0-9]{1,20}-[0-9]{1,5}$/)?.[0] !== executionId)
    throw new OperationError('INPUT_INVALID', 'Invalid Actions run identity');
  failureContext.executionId = executionId;
  const source = executionSource();
  if (source.sha !== required('GITHUB_SHA'))
    throw new OperationError('IDENTITY_MISMATCH', 'Untested cloud source');
  failureContext.validating = false;
  const definition = async () => {
    if (!input || input.match(/^data\/leagues\/[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/)?.[0] !== input)
      throw new OperationError('INPUT_INVALID', 'Expected a committed data/leagues definition');
    return cloudJson(join(repository, input), undefined, 'INPUT_INVALID');
  };
  if (command === 'probe') {
    const result = await probeLeague(
      await definition(),
      source.sha,
      publicHttp(required('PUBLICATION_WORKER_URL')),
    );
    await writeCloudJson(join(root, 'probe.json'), result);
    await appendFile(required('GITHUB_OUTPUT'), `needed=${result.needed}\n`);
    await appendFile(required('GITHUB_STEP_SUMMARY'), `League probe: ${JSON.stringify(result)}\n`);
  } else if (command === 'prepare') {
    const result = await prepareCloudLeague(
      await definition(),
      source,
      executionId,
      join(root, 'public'),
      join(root, 'prepared'),
      await cloudJson(join(root, 'inventory.json')),
    );
    await appendFile(
      required('GITHUB_STEP_SUMMARY'),
      `League admission estimate: ${JSON.stringify(result.estimate)}\n`,
    );
  } else if (command === 'run') {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGTERM', cancel);
    process.once('SIGINT', cancel);
    try {
      console.log(
        await runCloudLeague(
          join(root, 'input'),
          join(root, 'output'),
          source,
          executionId,
          controller.signal,
        ),
      );
    } finally {
      process.removeListener('SIGTERM', cancel);
      process.removeListener('SIGINT', cancel);
    }
  } else if (command === 'finish') {
    const result = await finishCloudLeague(
      join(root, 'prepared'),
      join(root, 'results'),
      join(root, 'public'),
      source,
      executionId,
    );
    await appendFile(required('GITHUB_STEP_SUMMARY'), `League result: ${JSON.stringify(result)}\n`);
  } else {
    const viewer = publicHttp(required('PUBLICATION_VIEWER_URL'), 7200000);
    const inventory = await transferCloudLeague(
      {
        accountId: required('R2_ACCOUNT_ID'),
        bucket: required('R2_BUCKET'),
        accessKeyId: required('R2_ACCESS_KEY_ID'),
        secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
      },
      join(root, 'public'),
      join(root, 'reports'),
      {
        id: executionId + '-' + command,
        sourceSha: source.sha,
        day: new Date().toISOString().slice(0, 10),
      },
      command === 'restore'
        ? undefined
        : {
            viewer: async () => {
              const bytes = await viewer('build.json', 4096);
              return operationInput(
                () =>
                  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
                'DATA_INVALID',
              );
            },
            worker: publicHttp(required('PUBLICATION_WORKER_URL'), 7200000),
            ancestor: (data, deployed) => ancestorOf(data, deployed, repository),
          },
    );
    if (command === 'restore') await writeCloudJson(join(root, 'inventory.json'), inventory);
  }
}
await main().catch(async (error: unknown) => {
  process.exitCode = 1;
  await reportLeagueFailure(error, failureContext, reportRoot, process.env.GITHUB_STEP_SUMMARY);
});
