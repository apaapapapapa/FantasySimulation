import { join } from 'node:path';
import { appendFile, writeFile, mkdir } from 'node:fs/promises';
import { Measurements, measureAsync } from '@fantasy/api/tooling';
import { canonicalJson, contentHash, LeaguePipelineControlSchema } from '@fantasy/domain/spatial';
import {
  cloudJson,
  cloudInput,
  writeCloudJson,
} from '../apps/cli/src/league/league-cloud-files.ts';
import { prepareCloudLeague } from '../apps/cli/src/league/league-cloud.ts';
import { assignLeagueRunners } from '../apps/cli/src/league/league-assignment.ts';
import { leagueCostProfile } from '../apps/cli/src/league/league-cost-profile.ts';
import { leagueArtifactFiles } from '../apps/cli/src/league/league-artifact-files.ts';
import { finalizeLeaguePipeline } from '../apps/cli/src/league/league-finalizer.ts';
import { LeagueStaging } from '../apps/cli/src/league/league-staging.ts';
import { encodeLeagueCheckpoint } from '../apps/cli/src/league/league-checkpoint.ts';
import {
  PublicationEvidence,
  evidenceGraph,
} from '../apps/cli/src/publication/publication-evidence.ts';
import { publicationInventory } from '../apps/cli/src/publication/publication-files.ts';
import { MemoryStore } from '../apps/cli/test-support/remote-store.ts';
import { computePipeline } from './league-pipeline-compute.ts';
import { receiveBaseline, receivePartitionPilot } from './league-pipeline-receive.ts';
import { uploadPipelineArtifact } from './league-pipeline-upload.ts';
import { pipelineCapacity, pipelineCi } from './league-pipeline-policy.ts';
import type { PipelineContext } from './league-pipeline-context.ts';
import {
  partitionPilotInputs,
  partitionPilotRunners,
  validatePartitionPilotPrepared,
} from './league-partition-pilot-inputs.ts';

export async function preparePartitionPilot(context: PipelineContext, runners: number) {
  partitionPilotRunners(runners);
  const registration = await partitionPilotInputs();
  await pipelineCi(context.github, context.ciRun, 'start');
  const publicRoot = join(context.root, 'public'),
    preparedRoot = join(context.root, 'prepared');
  await mkdir(publicRoot, { recursive: true });
  const before = await publicationInventory(publicRoot);
  if (before.size) throw new Error('Partition pilot requires a fresh empty local namespace');
  const outcome = await prepareCloudLeague(
    registration.definition,
    context.identity.source,
    context.prefix,
    publicRoot,
    preparedRoot,
    {
      files: before.size,
      bytes: [...before.values()].reduce((n, bytes) => n + bytes, 0),
      receipts: 0,
      usedReadRequests: 10000,
      usedWriteRequests: 10000,
    },
  );
  await validatePartitionPilotPrepared(preparedRoot, context.identity, runners);
  const assignment = assignLeagueRunners(outcome.prepared.plan, runners);
  pipelineCapacity(outcome.prepared.inputs.length, assignment);
  const baseline = await PublicationEvidence.audit(publicRoot);
  const graph = evidenceGraph(baseline);
  // Real local graph accounting; this is not an R2 reservation or billing observation.
  const admissionWrites = [...graph.files.keys()].filter((key) => !before.has(key)).length + 1;
  await writeCloudJson(
    join(preparedRoot, 'control.json'),
    LeaguePipelineControlSchema.parse({
      schemaVersion: 1,
      identity: context.identity,
      runners,
      ciRunId: context.ciRun,
      catalogHash: graph.current.catalogHash,
      admissionWrites,
    }),
  );
  await writeFile(
    join(preparedRoot, 'checkpoint.gz'),
    encodeLeagueCheckpoint(baseline.checkpoint(context.identity)),
    { flag: 'wx' },
  );
  const inputs = [
    ...(await leagueArtifactFiles(preparedRoot, 'inputs')).files,
    join(preparedRoot, 'control.json'),
  ];
  const baselineFiles = [
    'prepared.json',
    'control.json',
    'checkpoint.gz',
    ...outcome.prepared.inputs.map((_, index) => `inputs/${index}/input.json`),
  ];
  const artifacts = [
    await uploadPipelineArtifact(context.prefix + '-inputs', inputs, preparedRoot),
    await uploadPipelineArtifact(
      context.prefix + '-baseline',
      baselineFiles.map((key) => join(preparedRoot, key)),
      preparedRoot,
    ),
  ];
  await writeCloudJson(join(context.root, 'registration.json'), {
    ...registration,
    identity: context.identity,
    runners,
    workers: 2,
    reuse: 0,
    formalAcceptance: false,
    transport: 'GitHub immutable SDK archives; local MemoryStore staging, no R2',
    assignment,
    admissionWrites,
    artifacts,
    metadata: context.github.metrics(),
  });
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify({ index: assignment.map((entry) => entry.runner) })}\n`,
    );
  return { assignment, artifacts };
}

export async function computePartitionPilot(
  context: PipelineContext,
  runners: number,
  runner: number,
  signal: AbortSignal,
) {
  partitionPilotRunners(runners);
  if (!Number.isInteger(runner) || runner < 0 || runner >= runners)
    throw new Error('Foreign pilot runner');
  const measured = new Measurements();
  const sampling = setInterval(() => measured.sample(), 250);
  sampling.unref();
  let status = 'failed';
  try {
    const outcome = await measured.run(() =>
      computePipeline(
        context.root,
        context.github,
        context.identity,
        runner,
        signal,
        async (root) => {
          const control = LeaguePipelineControlSchema.parse(
            await cloudJson(join(root, 'control.json')),
          );
          if (
            control.runners !== runners ||
            control.ciRunId !== context.ciRun ||
            canonicalJson(control.identity) !== canonicalJson(context.identity)
          )
            throw new Error('Foreign pilot control');
          await validatePartitionPilotPrepared(root, context.identity, runners);
        },
        true,
      ),
    );
    const { prepared } = await validatePartitionPilotPrepared(
      join(context.root, 'prepared'),
      context.identity,
      runners,
    );
    const assigned = assignLeagueRunners(prepared.plan, runners)[runner]!;
    const expected = new Set<string>();
    for (const index of assigned.partitions)
      for (const slot of (await cloudInput(join(context.root, 'prepared'), prepared, index)).batch
        .slots)
        expected.add(slot.simulationHash);
    const matches = measured.report().matches;
    if (
      matches.length !== expected.size ||
      new Set(matches.map((match) => match.simulationHash)).size !== expected.size ||
      matches.some(
        (match) =>
          !expected.has(match.simulationHash) ||
          !match.worker ||
          !['win', 'draw'].includes(match.outcome),
      )
    )
      throw new Error('Pilot measured fresh match coverage mismatch');
    await writeCloudJson(
      join(context.root, 'cost-profile.json'),
      await leagueCostProfile(context.identity.source, matches),
    );
    status = 'completed';
    return outcome;
  } finally {
    clearInterval(sampling);
    await writeCloudJson(join(context.root, 'measurement.json'), {
      ...measured.report(),
      identity: context.identity,
      runner,
      runners,
      status,
      metadata: context.github.metrics(),
      timing:
        'Process wall includes actual compute, validation, sealing and SDK upload; overlapping spans are not summed.',
    });
  }
}

export async function consumePartitionPilot(
  context: PipelineContext,
  runners: number,
  signal: AbortSignal,
) {
  partitionPilotRunners(runners);
  const { control, baseline, preparedRoot } = await receiveBaseline(
    context.root,
    context.github,
    3600000,
  );
  if (control.runners !== runners || control.ciRunId !== context.ciRun)
    throw new Error('Foreign pilot baseline control');
  const store = new MemoryStore(),
    staging = new LeagueStaging(store, new Map(), 1000, 64 * 1024 ** 2);
  try {
    const received = await receivePartitionPilot(
      context.root,
      preparedRoot,
      context.github,
      runners,
      staging,
      signal,
      async (root) => {
        await validatePartitionPilotPrepared(root, context.identity, runners);
      },
    );
    const finalized = await measureAsync('receiver.finalize', () =>
      finalizeLeaguePipeline(
        preparedRoot,
        join(context.root, 'final'),
        received.producers,
        received.terminals,
        context.identity,
        runners,
        async () => {
          if (!(await context.github.successfulProducers(runners)))
            throw new Error('Successful pilot producer jobs required');
        },
        baseline,
      ),
    );
    const registered = await partitionPilotInputs();
    const expected = new Map(registered.expected.map((entry) => [entry.simulationHash, entry]));
    const signatures = [];
    for (const producer of received.producers)
      for (const replay of evidenceGraph(producer.evidence).replays.values()) {
        const wanted = expected.get(replay.receipt.simulationHash);
        if (!wanted || (await contentHash(replay.manifest.input)) !== wanted.manifestHash)
          throw new Error('Foreign pilot replay');
        signatures.push({
          index: wanted.index,
          simulationHash: replay.receipt.simulationHash,
          signature: await contentHash({
            simulationHash: replay.receipt.simulationHash,
            input: replay.manifest.input,
            result: replay.receipt.result,
            records: replay.manifest.records,
            eventHash: replay.manifest.eventHash,
            trajectoryHash: replay.manifest.trajectoryHash,
            chunks: replay.manifest.chunks,
            checkpoints: replay.manifest.checkpoints,
          }),
        });
      }
    if (signatures.length !== 380 || new Set(signatures.map((entry) => entry.index)).size !== 380)
      throw new Error('Missing pilot signatures');
    await writeCloudJson(
      join(context.root, 'signature-index.json'),
      signatures.sort((a, b) => a.index - b.index),
    );
    await writeCloudJson(join(context.root, 'receipt.json'), {
      identity: context.identity,
      runners,
      completed: 380,
      formalAcceptance: false,
      snapshot: finalized.snapshot,
      staging: staging.metrics(),
      metadata: context.github.metrics(),
      retainedFixtureBytes: [...store.objects.values()].reduce(
        (n, value) => n + value.data.length,
        0,
      ),
      publication: 'Local-only MemoryStore fixture; no R2 PUT or public revision selection.',
    });
    return finalized;
  } finally {
    await staging.close();
  }
}
