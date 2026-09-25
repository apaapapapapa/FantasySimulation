import { appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionSource } from '@fantasy/api/tooling';
import { probeLeague } from './league/league-probe.ts';
import { prepareCloudLeague, runCloudLeague, finishCloudLeague } from './league/league-cloud.ts';
import { cloudJson, writeCloudJson } from './league/league-cloud-files.ts';
import { transferCloudLeague } from './league/league-transfer.ts';
import { publicHttp, ancestorOf } from './publication/publication-http.ts';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
async function main() {
  const [command, directory, input] = process.argv.slice(2);
  if (
    !directory ||
    !['probe', 'restore', 'prepare', 'admit', 'run', 'finish', 'publish'].includes(command ?? '')
  )
    throw new Error('Invalid league cloud command');
  const root = resolve(directory),
    source = executionSource();
  const executionId = `league-${required('GITHUB_RUN_ID')}-${required('GITHUB_RUN_ATTEMPT')}`;
  if (source.sha !== required('GITHUB_SHA')) throw new Error('Untested cloud source');
  const definition = async () => {
    if (!input || !/^data\/leagues\/[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/.test(input))
      throw new Error('Expected a committed data/leagues definition');
    return cloudJson(join(repository, input));
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
    const viewer = publicHttp(required('PUBLICATION_VIEWER_URL'));
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
            viewer: async () =>
              JSON.parse((await viewer('build.json', 4096)).toString('utf8')) as unknown,
            worker: publicHttp(required('PUBLICATION_WORKER_URL')),
            ancestor: (data, deployed) => ancestorOf(data, deployed, repository),
          },
    );
    if (command === 'restore') await writeCloudJson(join(root, 'inventory.json'), inventory);
  }
}
await main().catch(() => {
  console.error(
    'League cloud operation failed; no credentials or private diagnostics logged. Inspect phase metrics and validated inputs.',
  );
  process.exitCode = 1;
});
