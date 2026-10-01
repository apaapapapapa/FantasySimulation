import { join, resolve } from 'node:path';
import { mkdir, statfs } from 'node:fs/promises';
import { executionSource, Measurements } from '@fantasy/api/tooling';
import { pipelineContext, requiredPipeline } from './league-pipeline-context.ts';
import { PipelineArtifacts } from './league-pipeline-artifacts.ts';
import type { PipelineIdentity } from '../apps/cli/src/league/league-producer.ts';
import { pipelineCi } from './league-pipeline-policy.ts';
import { writeCloudJson } from '../apps/cli/src/league/league-cloud-files.ts';
import { partitionPilotRunners } from './league-partition-pilot-inputs.ts';
import {
  preparePartitionPilot,
  computePartitionPilot,
  consumePartitionPilot,
} from './league-partition-pilot-driver.ts';

const command = process.argv[2],
  root = resolve('.generated/league-partition-pilot');
const controller = new AbortController(),
  measured = new Measurements();
const cancel = () => controller.abort(new Error('Partition pilot cancelled'));
process.once('SIGTERM', cancel);
process.once('SIGINT', cancel);
const sampling = setInterval(() => {
  measured.sample();
  if (process.memoryUsage().rss > 1024 ** 3)
    controller.abort(new Error('Partition pilot RSS bound'));
}, 250);
sampling.unref();
let status = 'failed',
  failure: string | null = null;
let availableDiskBytes: number | null = null;
let identity: PipelineIdentity | null = null;
const deadline = setTimeout(
  () => controller.abort(new Error('Partition pilot 29-minute deadline')),
  29 * 60000,
);
deadline.unref();
try {
  await mkdir(root, { recursive: true });
  const disk = await statfs(root);
  availableDiskBytes = disk.bavail * disk.bsize;
  if (!Number.isSafeInteger(availableDiskBytes) || availableDiskBytes < 1024 ** 3)
    throw new Error('Partition pilot requires one GiB of measured free disk');
  await measured.run(async () => {
    if (!['prepare', 'compute', 'consume'].includes(command ?? ''))
      throw new Error('Unknown partition pilot command');
    const runners = partitionPilotRunners(Number(requiredPipeline('LEAGUE_RUNNERS')));
    const context = await pipelineContext(root);
    identity = context.identity;
    context.github = new PipelineArtifacts(
      context.token,
      context.identity,
      command === 'compute' ? 20 : command === 'prepare' ? 30 : 200,
      'league-partition-pilot.yml',
    );
    if (command === 'consume') context.github.reserveOtherMetadata(30 + 20 * runners + 12);
    await pipelineCi(context.github, context.ciRun, 'start');
    await context.github.authenticateRun();
    if (command === 'prepare') await preparePartitionPilot(context, runners);
    else if (command === 'compute')
      await computePartitionPilot(
        context,
        runners,
        Number(requiredPipeline('LEAGUE_RUNNER')),
        controller.signal,
      );
    else await consumePartitionPilot(context, runners, controller.signal);
    controller.signal.throwIfAborted();
    if (executionSource().sha !== context.identity.source.sha)
      throw new Error('Pilot source changed');
    if (process.resourceUsage().maxRSS * 1024 > 1024 ** 3)
      throw new Error('Pilot lifetime RSS bound');
  });
  status = 'completed';
} catch (error) {
  failure = error instanceof Error ? error.message : 'Unknown pilot failure';
  process.exitCode = 1;
} finally {
  clearInterval(sampling);
  clearTimeout(deadline);
  process.removeListener('SIGTERM', cancel);
  process.removeListener('SIGINT', cancel);
  await writeCloudJson(join(root, 'phase-measurement.json'), {
    ...measured.report(),
    status,
    failure,
    command,
    identity,
    source: executionSource(),
    formalAcceptance: false,
    metadataScope:
      'PipelineArtifacts REST calls; @actions/artifact upload service calls are a separate SDK scope.',
    processLifetimeMaxRssKiB: process.resourceUsage().maxRSS,
    availableDiskBytes,
  });
}
