import { join, resolve } from 'node:path';
import { mkdir, statfs } from 'node:fs/promises';
import { executionSource, Measurements } from '@fantasy/api/tooling';
import { pipelineContext, requiredPipeline } from './league-pipeline-context.ts';
import { PipelineArtifacts } from './league-pipeline-artifacts.ts';
import type { PipelineIdentity } from '../apps/cli/src/league/league-producer.ts';
import { pipelineCi } from './league-pipeline-policy.ts';
import { writeCloudJson } from '../apps/cli/src/league/league-cloud-files.ts';
import {
  calibrationRunners,
  validateCalibrationBudget,
} from './league-runner-calibration-policy.ts';
import {
  uploadCalibrationArtifact,
  beginCalibrationTransportJob,
  calibrationTransportSnapshot,
} from './league-calibration-upload.ts';
import {
  prepareRunnerCalibration,
  preparePartitionPilot,
  computeRunnerCalibration,
  computePartitionPilot,
  consumeRunnerCalibration,
  consumePartitionPilot,
} from './league-partition-pilot-driver.ts';

import { partitionPilotRunners } from './league-partition-pilot-inputs.ts';
import { redact } from './harness/process.ts';

export async function runPilotCommand(
  calibration: boolean,
  root = resolve(
    calibration ? '.generated/league-runner-calibration' : '.generated/league-partition-pilot',
  ),
) {
  const checkRunners = calibration ? calibrationRunners : partitionPilotRunners;
  const prepare = calibration ? prepareRunnerCalibration : preparePartitionPilot;
  const compute = calibration ? computeRunnerCalibration : computePartitionPilot;
  const consume = calibration ? consumeRunnerCalibration : consumePartitionPilot;
  const command = process.argv[2];
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
      const runners = checkRunners(Number(requiredPipeline('LEAGUE_RUNNERS')));
      if (calibration)
        validateCalibrationBudget(
          JSON.parse(requiredPipeline('LEAGUE_CALIBRATION_BUDGET')),
          executionSource().sha,
        );
      const context = await pipelineContext(root);
      identity = context.identity;
      context.github = new PipelineArtifacts(
        context.token,
        context.identity,
        command === 'compute' ? 20 : command === 'prepare' ? 30 : 200,
        calibration ? 'league-runner-calibration.yml' : 'league-partition-pilot.yml',
      );
      if (command === 'consume') context.github.reserveOtherMetadata(30 + 20 * runners + 12);
      await pipelineCi(context.github, context.ciRun, 'start');
      await context.github.authenticateRun();

      // Fixed shares precede preparation or the first simulation. No retry resets them.
      if (calibration) {
        // Includes artifacts from earlier failed attempts; reserve the whole wave again.
        const artifacts = await context.github.request(
          'GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts',
          { run_id: context.identity.runId, per_page: 1 },
        );
        beginCalibrationTransportJob(command!, runners, context.prefix, artifacts.total_count);
      }

      if (command === 'prepare') await prepare(context, runners);
      else if (command === 'compute')
        await compute(
          context,
          runners,
          Number(requiredPipeline('LEAGUE_RUNNER')),
          controller.signal,
        );
      else await consume(context, runners, controller.signal);
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
    const bounded = (value: string) => redact(value, process.env).slice(0, 2048);
    console.error(
      JSON.stringify({
        command: bounded(command ?? ''),
        status: 'failed',
        formalAcceptance: false,
        error: {
          type: bounded(error instanceof Error ? error.name : 'NonError'),
          message: bounded(failure),
        },
      }),
    );
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
      ...(calibration ? { transportReservation: calibrationTransportSnapshot() } : {}),
      metadataScope:
        'PipelineArtifacts REST calls; @actions/artifact upload service calls are a separate SDK scope.',
      processLifetimeMaxRssKiB: process.resourceUsage().maxRSS,
      availableDiskBytes,
    });
    const measuredIdentity = identity as PipelineIdentity | null;
    if (calibration && measuredIdentity && status === 'completed' && !controller.signal.aborted) {
      const files = ['phase-measurement.json'];
      if (command === 'prepare') files.push('registration.json');
      if (command === 'compute' && status === 'completed')
        files.push('measurement.json', 'cost-profile.json');
      if (command === 'consume' && status === 'completed')
        files.push('receipt.json', 'signature-index.json');
      await uploadCalibrationArtifact(
        `league-${measuredIdentity.runId}-${measuredIdentity.runAttempt}-${command}-${process.env.LEAGUE_RUNNER ?? 'shared'}-metrics`,
        files.map((file) => join(root, file)),
        root,
      );
    }
  }
}
