import { join } from 'node:path';
import { appendFile, writeFile } from 'node:fs/promises';
import {
  LeagueCostProfileSchema,
  LeaguePipelineControlSchema,
  canonicalJson,
} from '@fantasy/domain/spatial';
import {
  cloudJson,
  writeCloudJson,
  preparedLeague,
} from '../apps/cli/src/league/league-cloud-files.ts';
import { prepareCloudLeague } from '../apps/cli/src/league/league-cloud.ts';
import { restoreLeagueRetained } from '../apps/cli/src/league/league-retained.ts';
import { assignLeagueRunners } from '../apps/cli/src/league/league-assignment.ts';
import { preparedLeagueCosts } from '../apps/cli/src/league/league-cost-profile.ts';
import { leagueArtifactFiles } from '../apps/cli/src/league/league-artifact-files.ts';
import { openLeagueStaging } from '../apps/cli/src/league/league-staging.ts';
import { leagueUsageTotals } from '../apps/cli/src/league/league-transfer.ts';
import { copyEvidenceMetadata } from '../apps/cli/src/league/league-finalizer.ts';
import {
  PublicationEvidence,
  evidenceGraph,
} from '../apps/cli/src/publication/publication-evidence.ts';
import { publishPublicationEvidence } from '../apps/cli/src/publication/publication-remote.ts';
import {
  encodeLeagueCheckpoint,
  CHECKPOINT_RESERVE_BYTES,
} from '../apps/cli/src/league/league-checkpoint.ts';
import { durableLeagueCheckpoint } from './league-pipeline-checkpoint.ts';
import { uploadPipelineArtifact } from './league-pipeline-upload.ts';
import {
  pipelineCapacity,
  pipelineCi,
  pipelineRunners,
  requireArtifactPilot,
} from './league-pipeline-policy.ts';
import {
  pipelineAuditAge,
  pipelineR2,
  pipelineLease,
  pipelineDefinition,
  pipelineAncestry,
  localPipelineEvidence,
  pipelinePublicationOptions,
  requiredPipeline,
  type PipelineContext,
} from './league-pipeline-context.ts';

export async function restorePipeline(context: PipelineContext) {
  const definition = await pipelineDefinition();
  // Reject unmeasured inputs/capacity before any R2 lease or request.
  await pipelineProfile();
  pipelineRunners(requiredPipeline('LEAGUE_RUNNERS'), process.env.LEAGUE_APPROVED_RUNNERS);
  await pipelineCi(context.github, context.ciRun, 'start');
  await requireArtifactPilot(context.github, Number(requiredPipeline('LEAGUE_PILOT_RUN')));
  const session = await openLeagueStaging(pipelineR2(), pipelineLease(context, 'restore'));
  try {
    const maxAgeMs = pipelineAuditAge();
    const prior =
      maxAgeMs === null
        ? null
        : await durableLeagueCheckpoint(session.store, context.root, {
            token: context.token,
            validatorDigest: context.identity.validatorDigest,
            maxAgeMs,
            ancestor: (sha) => pipelineAncestry(sha, context.identity.source.sha),
          });
    const evidence =
      prior ??
      (await PublicationEvidence.remoteAudit(async (key, limit) => {
        const value = await session.store.read(key, limit);
        if (!value) throw new Error('Missing publication during full legacy audit');
        return value.data;
      }));
    const inventory = {
      files: session.inventory.size,
      bytes: [...session.inventory.values()].reduce((a, b) => a + b, 0),
      receipts: [...evidenceGraph(evidence).replays].length,
      ...leagueUsageTotals(session.usage),
    };
    const root = join(context.root, 'public');
    await copyEvidenceMetadata(evidence, root);
    await restoreLeagueRetained(
      evidence,
      definition,
      context.identity.source,
      inventory,
      session.store,
      root,
    );
    await writeCloudJson(join(context.root, 'inventory.json'), inventory);
    await writeFile(
      join(context.root, 'restored.gz'),
      encodeLeagueCheckpoint(evidence.checkpoint(context.identity)),
      { flag: 'wx' },
    );
  } finally {
    await session.close();
  }
}
async function pipelineProfile() {
  const path = requiredPipeline('LEAGUE_COST_PROFILE');
  if (!/^docs\/measurements\/[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/.test(path))
    throw new Error('Expected committed measured cost profile');
  return LeagueCostProfileSchema.parse(await cloudJson(path));
}
export async function preparePipeline(context: PipelineContext) {
  const evidence = await localPipelineEvidence(context, 'restored.gz');
  const root = join(context.root, 'prepared');
  const runners = pipelineRunners(
    requiredPipeline('LEAGUE_RUNNERS'),
    process.env.LEAGUE_APPROVED_RUNNERS,
  );
  const outcome = await prepareCloudLeague(
    await pipelineDefinition(),
    context.identity.source,
    context.prefix,
    join(context.root, 'public'),
    root,
    await cloudJson(join(context.root, 'inventory.json')),
    undefined,
    { evidence, maxInputBytes: 56 * 1024 ** 2 },
  );
  await writeCloudJson(join(root, 'cost-profile.json'), await pipelineProfile());
  const assignment = assignLeagueRunners(
    outcome.prepared.plan,
    runners,
    await preparedLeagueCosts(root, outcome.prepared, true),
  );
  pipelineCapacity(outcome.prepared.inputs.length, assignment);
  const baseline = await PublicationEvidence.derive(join(context.root, 'public'), [evidence]);
  const before = evidenceGraph(evidence),
    graph = evidenceGraph(baseline);
  const admissionWrites =
    [...graph.files.keys()].filter((key) => !before.files.has(key)).length + 1;
  const control = LeaguePipelineControlSchema.parse({
    schemaVersion: 1,
    identity: context.identity,
    runners: assignment.length,
    ciRunId: context.ciRun,
    catalogHash: graph.current.catalogHash,
    admissionWrites,
  });
  await writeCloudJson(join(root, 'control.json'), control);
  await writeFile(
    join(root, 'checkpoint.gz'),
    encodeLeagueCheckpoint(baseline.checkpoint(context.identity)),
    { flag: 'wx' },
  );
  // One immutable input archive must exist before durable attempt admission.
  await uploadPipelineArtifact(
    context.prefix + '-inputs',
    [...(await leagueArtifactFiles(root, 'inputs')).files, join(root, 'control.json')],
    root,
  );
  await appendFile(
    requiredPipeline('GITHUB_OUTPUT'),
    `matrix=${JSON.stringify({ index: assignment.map((a) => a.runner) })}\n`,
  );
}
export async function admitPipeline(context: PipelineContext) {
  const root = join(context.root, 'prepared');
  const evidence = await localPipelineEvidence(context, 'prepared/checkpoint.gz');
  const control = LeaguePipelineControlSchema.parse(await cloudJson(join(root, 'control.json')));
  if (canonicalJson(control.identity) !== canonicalJson(context.identity))
    throw new Error('Admission identity mismatch');
  await pipelineCi(context.github, context.ciRun, 'start');
  const session = await openLeagueStaging(pipelineR2(), pipelineLease(context, 'admit'));
  try {
    await publishPublicationEvidence(
      evidence,
      async () => ({
        store: session.store,
        inventory: session.inventory,
        etags: session.store.listedEtags(),
      }),
      {
        ...pipelinePublicationOptions(),
        maxBytes: 8000000000 - CHECKPOINT_RESERVE_BYTES,
        maxWrites: 1000 - 2,
        beforeCommit: async () => {
          await pipelineCi(context.github, context.ciRun, 'finish');
        },
      },
    );
    const prepared = await preparedLeague(root);
    const files = [
      'prepared.json',
      'cost-profile.json',
      'control.json',
      'checkpoint.gz',
      ...prepared.inputs.map((_, i) => `inputs/${i}/input.json`),
    ];
    await uploadPipelineArtifact(
      context.prefix + '-baseline',
      files.map((file) => join(root, file)),
      root,
    );
  } finally {
    await session.close();
  }
}
