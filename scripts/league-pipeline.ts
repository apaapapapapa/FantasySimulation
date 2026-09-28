import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { measuredCommand } from '@fantasy/api/tooling';
import { reportLeagueFailure } from '../apps/cli/src/league/league-diagnostics.ts';
import { pipelineContext, requiredPipeline } from './league-pipeline-context.ts';
import { restorePipeline, preparePipeline, admitPipeline } from './league-pipeline-admit.ts';
import { computePipeline } from './league-pipeline-compute.ts';
import { transferPipeline } from './league-pipeline-transfer.ts';

const command = process.argv[2],
  root = resolve('.generated/league-pipeline');
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGTERM', cancel);
process.once('SIGINT', cancel);
const sampling = setInterval(() => {
  if (process.memoryUsage().rss > 1.5 * 1024 ** 3)
    controller.abort(new Error('Pipeline RSS bound'));
}, 1000);
sampling.unref();
await measuredCommand('pipeline-' + command, async () => {
  await mkdir(root, { recursive: true });
  const context = await pipelineContext(
    root,
    command === 'compute' ? 2 : command === 'restore' ? 20 : command === 'admit' ? 10 : 200,
  );
  if (command === 'restore') return restorePipeline(context);
  if (command === 'prepare') return preparePipeline(context);
  if (command === 'admit') return admitPipeline(context);
  if (command === 'compute')
    return computePipeline(
      root,
      context.github,
      context.identity,
      Number(requiredPipeline('LEAGUE_RUNNER')),
      controller.signal,
    );
  if (command === 'transfer' || command === 'recover')
    return transferPipeline(context, command === 'recover', controller.signal);
  throw new Error('Unknown pipeline command');
})
  .catch(async (error: unknown) => {
    process.exitCode = 1;
    await reportLeagueFailure(
      error,
      { command: 'pipeline-' + command },
      root,
      process.env.GITHUB_STEP_SUMMARY,
    );
  })
  .finally(() => {
    clearInterval(sampling);
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  });
