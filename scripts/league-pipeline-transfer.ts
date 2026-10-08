import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { canonicalJson } from '@fantasy/domain/spatial';
import { measureAsync } from '@fantasy/api/tooling';
import { openLeagueStaging } from '../apps/cli/src/league/league-staging.ts';
import { finalizeLeaguePipeline } from '../apps/cli/src/league/league-finalizer.ts';
import { evidenceGraph } from '../apps/cli/src/publication/publication-evidence.ts';
import { publishPublicationEvidence } from '../apps/cli/src/publication/publication-remote.ts';
import {
  encodeLeagueCheckpoint,
  persistLeagueCheckpoint,
} from '../apps/cli/src/league/league-checkpoint.ts';
import { writeCloudJson } from '../apps/cli/src/league/league-cloud-files.ts';
import { PipelineArtifacts } from './league-pipeline-artifacts.ts';
import { receiveBaseline, receivePipeline } from './league-pipeline-receive.ts';
import { uploadPipelineArtifact } from './league-pipeline-upload.ts';
import { pipelineCi } from './league-pipeline-policy.ts';
import {
  pipelineAuditAge,
  pipelineAncestry,
  pipelineR2,
  pipelineLease,
  pipelinePublicationOptions,
  requiredPipeline,
  type PipelineContext,
} from './league-pipeline-context.ts';

async function recoveredArtifacts(context: PipelineContext) {
  const runId = Number(requiredPipeline('LEAGUE_SOURCE_RUN')),
    runAttempt = Number(requiredPipeline('LEAGUE_SOURCE_ATTEMPT'));
  if (
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1
  )
    throw new Error('Invalid original execution');
  const run = await context.github.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
    run_id: runId,
  });
  if (run.status !== 'completed' || !['failure', 'cancelled', 'timed_out'].includes(run.conclusion))
    throw new Error('Recovery requires a finished, interrupted original publication');
  if (!pipelineAncestry(run.head_sha, context.identity.source.sha))
    throw new Error('Recovery source is not a main ancestor');
  // Execute current, CI-verified code only. Baseline authentication below requires the same validator.
  const identity = {
    ...context.identity,
    source: { ...context.identity.source, sha: run.head_sha },
    runId,
    runAttempt,
  };
  const github = new PipelineArtifacts(context.token, identity, 150);
  await github.authenticateRun();
  return github;
}
export async function transferPipeline(
  context: PipelineContext,
  recover: boolean,
  signal: AbortSignal,
) {
  await pipelineCi(context.github, context.ciRun, recover ? 'start' : 'finish');
  const github = recover ? await recoveredArtifacts(context) : context.github;
  const { control, baseline, preparedRoot } = await receiveBaseline(
    context.root,
    github,
    pipelineAuditAge() ?? 3600000,
  );
  // Includes every producer's two metadata reads, two runtime bootstrap reads, admit/checkpoint
  // authentication and timing control reads. Signed payload downloads are separately bounded.
  github.reserveOtherMetadata(recover ? 30 : 40 + 4 * control.runners);
  if (
    control.identity.validatorDigest !== context.identity.validatorDigest ||
    canonicalJson(control.identity.source) !== canonicalJson(github.identity.source)
  )
    throw new Error('Recovery validator/runtime mismatch');
  if (recover && !(await github.successfulProducers(control.runners)))
    throw new Error('Recovery requires all original producers to have succeeded');
  await pipelineCi(github, control.ciRunId, 'finish');
  const session = await openLeagueStaging(
    pipelineR2(),
    pipelineLease(context, recover ? 'recover' : 'transfer'),
  );
  try {
    const received = await receivePipeline(
      context.root,
      preparedRoot,
      github,
      control.runners,
      session.staging,
      signal,
    );
    const finalized = await measureAsync('receiver.finalize', () =>
      finalizeLeaguePipeline(
        preparedRoot,
        join(context.root, 'final'),
        received.producers,
        received.terminals,
        github.identity,
        control.runners,
        async () => {
          if (!(await github.successfulProducers(control.runners)))
            throw new Error('Producer success barrier changed');
        },
        baseline,
      ),
    );
    const graph = evidenceGraph(finalized.evidence);
    const league = graph.catalog.leagues?.find((ref) => ref.hash === finalized.snapshot.hash);
    if (!league) throw new Error('Finalized league is missing from its catalog');
    const metadataWrites =
      [...graph.files.keys()].filter(
        (key) => key !== 'catalog/current.json' && !session.inventory.has(key),
      ).length + 1;
    if (control.admissionWrites + session.staging.metrics().addedFiles + metadataWrites + 2 > 1000)
      throw new Error(
        'Entire pipeline new-object target exceeded; timing/capacity must be reviewed',
      );
    await pipelineCi(context.github, context.ciRun, 'finish');
    const checkpoint = join(context.root, 'checkpoint.gz');
    await writeFile(
      checkpoint,
      encodeLeagueCheckpoint(finalized.evidence.checkpoint(context.identity)),
      { flag: 'wx' },
    );
    const uploaded = await uploadPipelineArtifact(
      context.prefix + '-checkpoint',
      [checkpoint],
      context.root,
    );
    const ref = (await context.github.list()).find((a) => a.id === uploaded.id);
    if (!ref || canonicalJson(ref) !== canonicalJson(uploaded))
      throw new Error('Checkpoint upload metadata mismatch');
    // A failed writer's locator is never accepted on restore; current remains the final mutable PUT.
    await persistLeagueCheckpoint(
      session.store,
      {
        schemaVersion: 1,
        catalogHash: graph.current.catalogHash,
        identity: context.identity,
        writerRun: context.identity.runId,
        writerAttempt: context.identity.runAttempt,
        artifactId: ref.id,
        archiveHash: ref.digest,
        archiveBytes: ref.bytes,
      },
      await context.github.archive(ref),
    );
    const outcome = await publishPublicationEvidence(finalized.evidence, session.store, {
      ...pipelinePublicationOptions(),
      maxWrites: 1000 - control.admissionWrites - session.staging.metrics().addedFiles - 2,
      maxTransferBytes: 8000000000,
      signal,
      beforeCommit: async () => {
        await pipelineCi(context.github, context.ciRun, 'finish');
        await pipelineCi(github, control.ciRunId, 'finish');
        if (!(await github.successfulProducers(control.runners)))
          throw new Error('Producer barrier changed before commit');
      },
    });
    await writeCloudJson(join(context.root, 'completion.json'), {
      outcome,
      catalogHash: finalized.catalogHash,
      // The 300s acceptance applies only to a formal league computed without retained results.
      league: {
        id: league.id,
        snapshot: league.hash,
        status: finalized.status,
        planned: finalized.planned,
        resolved: finalized.resolved,
        reusedSlots: received.producers.reduce(
          (sum, producer) => sum + producer.result.index.slots.filter((slot) => slot.reused).length,
          0,
        ),
      },
      staging: session.staging.metrics(),
      metadata: github.metrics(),
      transport: session.store.metrics(),
      recover,
    });
    return outcome;
  } finally {
    await session.close();
  }
}
