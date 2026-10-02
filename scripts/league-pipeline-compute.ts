import { join } from 'node:path';
import { rm, lstat } from 'node:fs/promises';
import { LeaguePipelineControlSchema, canonicalJson } from '@fantasy/domain/spatial';
import {
  cloudJson,
  preparedLeague,
  cloudInput,
  writeCloudJson,
} from '../apps/cli/src/league/league-cloud-files.ts';
import { runCloudLeagueRunner } from '../apps/cli/src/league/league-runner.ts';
import {
  sealLeagueProducer,
  producerArtifactGroups,
  type PipelineIdentity,
} from '../apps/cli/src/league/league-producer.ts';
import { PipelineArtifacts, type PipelineArtifact } from './league-pipeline-artifacts.ts';
import { uploadPipelineArtifact } from './league-pipeline-upload.ts';
import { PackedLeagueUpload } from './league-packed-upload.ts';
import {
  requireCalibrationScope,
  CALIBRATION_LIMITS,
  calibrationRunRemaining,
} from './league-runner-calibration-policy.ts';
import { validateCalibrationPrepared } from './league-partition-pilot-inputs.ts';
import { uploadCalibrationArtifact, setCalibrationPartition } from './league-calibration-upload.ts';
import { validateCalibrationBudgetRecord } from './league-calibration-history.ts';

export const pipelineInputKey = (key: string) =>
  /^(prepared\.json|cost-profile\.json|control\.json|inputs\/(?:[0-9]|[1-5][0-9]|6[0-3])\/(?:input\.json|retained\/objects\/[a-f0-9]{64}\/(?:receipt\.json|manifest\.json|chunk-[0-9]{5}\.ndjson\.gz|checkpoint-[0-9]{5}\.json\.gz)))$/.test(
    key,
  );

export async function computePipeline(
  root: string,
  github: PipelineArtifacts,
  identity: PipelineIdentity,
  runner: number,
  signal: AbortSignal,
  beforeCompute?: (preparedRoot: string) => Promise<void>,
  packedTransport = false,
) {
  return computePipelineMode(
    root,
    github,
    identity,
    runner,
    signal,
    beforeCompute,
    packedTransport,
    false,
  );
}

export async function computeRunnerCalibrationPipeline(
  root: string,
  github: PipelineArtifacts,
  identity: PipelineIdentity,
  runner: number,
  signal: AbortSignal,
  beforeCompute: (preparedRoot: string) => Promise<void>,
) {
  const run = await github.authenticateRun();
  if (run.path !== '.github/workflows/league-runner-calibration.yml')
    throw new Error('Calibration workflow authentication required');
  calibrationRunRemaining(run.created_at);
  return computePipelineMode(
    root,
    github,
    identity,
    runner,
    signal,
    beforeCompute,
    true,
    true,
    run.created_at,
  );
}

async function computePipelineMode(
  root: string,
  github: PipelineArtifacts,
  identity: PipelineIdentity,
  runner: number,
  signal: AbortSignal,
  beforeCompute: ((preparedRoot: string) => Promise<void>) | undefined,
  packedTransport: boolean,
  calibration: boolean,
  createdAt?: unknown,
) {
  if (packedTransport && !beforeCompute)
    throw new Error('Packed diagnostic requires original-input admission');
  const prefix = `league-${identity.runId}-${identity.runAttempt}`;
  const all = await github.list(prefix + '-inputs'),
    input = all.find((a) => a.name === prefix + '-inputs');
  if (!input) throw new Error('Missing immutable shared input');
  const preparedRoot = join(root, 'prepared');
  await github.download(
    input,
    preparedRoot,
    calibration
      ? (key) => pipelineInputKey(key) || key === 'calibration-budget.json'
      : pipelineInputKey,
  );
  const control = LeaguePipelineControlSchema.parse(
    await cloudJson(join(preparedRoot, 'control.json')),
  );
  if (canonicalJson(control.identity) !== canonicalJson(identity))
    throw new Error('Shared input identity mismatch');
  if (calibration) await validateCalibrationBudgetRecord(preparedRoot, identity);
  await beforeCompute?.(preparedRoot);
  const prepared = await preparedLeague(preparedRoot),
    artifacts: PipelineArtifact[] = [];
  if (calibration) {
    requireCalibrationScope(prepared, control.runners, identity);
    await validateCalibrationPrepared(preparedRoot, identity, control.runners);
    if (!Number.isInteger(runner) || runner < 0 || runner >= control.runners)
      throw new Error('Foreign calibration runner');
  }
  if (
    packedTransport &&
    !calibration &&
    (![1, 2].includes(control.runners) ||
      !Number.isInteger(runner) ||
      runner < 0 ||
      runner >= control.runners ||
      prepared.inputs.length !== 3 ||
      prepared.plan.partitions.length !== 3 ||
      prepared.plan.partitions.reduce((n, partition) => n + partition.slots, 0) !== 380)
  )
    throw new Error('Packed diagnostic requires exact380/three-partition/one-or-two-runner scope');
  const packed = packedTransport
    ? new PackedLeagueUpload(
        join(root, 'packed-spool'),
        identity,
        runner,
        signal,
        artifacts,
        calibration ? uploadCalibrationArtifact : uploadPipelineArtifact,
      )
    : undefined;
  const upload = calibration ? uploadCalibrationArtifact : uploadPipelineArtifact;
  try {
    const deadlineMs = calibration
      ? Math.min(1500000, calibrationRunRemaining(createdAt))
      : undefined;
    const outcome = await runCloudLeagueRunner(
      preparedRoot,
      join(root, 'results'),
      identity.source,
      prefix,
      {
        runner,
        runners: control.runners,
        workers: 2,
        signal,
        ...(deadlineMs === undefined ? {} : { deadlineMs }),
        completed: async (index, directory, pool, bundles) => {
          const producerRoot = join(root, 'spool', String(index));
          const proof = await sealLeagueProducer(
            await cloudInput(preparedRoot, prepared, index),
            directory,
            producerRoot,
            identity,
            runner,
            pool,
            bundles,
          );
          const sealedAt = performance.now();
          const controls = ['proof.json', 'result.json'].map((name) => join(producerRoot, name));
          const controlBytes = (await Promise.all(controls.map((path) => lstat(path)))).reduce(
            (n, info) => n + info.size,
            0,
          );
          const groups = producerArtifactGroups(proof.files, controlBytes);
          if (groups.length > 3) throw new Error('Producer artifact quota exceeded');
          if (calibration) {
            const raw = controlBytes + proof.files.reduce((sum, file) => sum + file.bytes, 0);
            if (!Number.isSafeInteger(raw) || raw > CALIBRATION_LIMITS.rawPartitionBytes)
              throw new Error('Calibration sealed partition raw-byte bound');
            setCalibrationPartition(index);
          }
          const adopted = packed ? await packed.append(producerRoot, proof, sealedAt) : false;
          if (calibration && adopted) await packed!.flush();
          if (!adopted) {
            if (artifacts.length + groups.length > 30)
              throw new Error('Producer artifact quota exceeded');
            for (const [part, files] of groups.entries())
              artifacts.push(
                await upload(
                  `${prefix}-runner-${runner}-partition-${index}-part-${part}-of-${groups.length}`,
                  [...controls, ...files.map((file) => join(producerRoot, 'public', file.key))],
                  producerRoot,
                ),
              );
          }
          if (!adopted) await rm(producerRoot, { recursive: true });
          await rm(directory, { recursive: true });
        },
      },
    );
    await packed?.finish();
    await writeCloudJson(join(root, 'terminal.json'), {
      schemaVersion: 1,
      identity,
      runner,
      partitions: outcome.assignment.partitions,
      artifacts,
    });
    await upload(`${prefix}-terminal-${runner}`, [join(root, 'terminal.json')], root);
    return { ...outcome, artifactCount: artifacts.length + 1, metadata: github.metrics() };
  } finally {
    await packed?.close();
  }
}
