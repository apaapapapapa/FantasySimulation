import { join } from 'node:path';
import { executionSource } from '@fantasy/api/tooling';
import { LeaguePipelineIdentitySchema, canonicalJson } from '@fantasy/domain/spatial';
import { cloudJson } from '../apps/cli/src/league/league-cloud-files.ts';
import { leagueValidatorDigest } from '../apps/cli/src/league/league-validator.ts';
import { PublicationEvidence } from '../apps/cli/src/publication/publication-evidence.ts';
import { decodeLeagueCheckpoint } from '../apps/cli/src/league/league-checkpoint.ts';
import { readFile } from 'node:fs/promises';
import { publicHttp, ancestorOf } from '../apps/cli/src/publication/publication-http.ts';
import { PipelineArtifacts } from './league-pipeline-artifacts.ts';

export const requiredPipeline = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
export async function pipelineContext(root: string, maxMetadataCalls = 200) {
  const source = executionSource();
  if (source.sha !== requiredPipeline('GITHUB_SHA') || process.env.GITHUB_REF !== 'refs/heads/main')
    throw new Error('Pipeline requires a clean tested main checkout');
  const identity = LeaguePipelineIdentitySchema.parse({
    source,
    runId: Number(requiredPipeline('GITHUB_RUN_ID')),
    runAttempt: Number(requiredPipeline('GITHUB_RUN_ATTEMPT')),
    validatorDigest: await leagueValidatorDigest(process.cwd()),
  });
  const token = requiredPipeline('LEAGUE_ARTIFACT_TOKEN');
  return {
    root,
    identity,
    token,
    prefix: `league-${identity.runId}-${identity.runAttempt}`,
    github: new PipelineArtifacts(token, identity, maxMetadataCalls),
    ciRun: Number(requiredPipeline('LEAGUE_CI_RUN')),
  };
}
export type PipelineContext = Awaited<ReturnType<typeof pipelineContext>>;
export function pipelineR2() {
  if (
    requiredPipeline('R2_PUBLICATION_ENABLED') !== 'true' ||
    requiredPipeline('LEAGUE_PIPELINE_ENABLED') !== 'true'
  )
    throw new Error('Pipeline production publication is disabled');
  return {
    accountId: requiredPipeline('R2_ACCOUNT_ID'),
    bucket: requiredPipeline('R2_BUCKET'),
    accessKeyId: requiredPipeline('R2_ACCESS_KEY_ID'),
    secretAccessKey: requiredPipeline('R2_SECRET_ACCESS_KEY'),
  };
}
export const pipelineLease = (context: PipelineContext, phase: string) => ({
  id: context.prefix + '-' + phase,
  sourceSha: context.identity.source.sha,
  day: new Date().toISOString().slice(0, 10),
});
export function pipelineAuditAge() {
  const policy = process.env.LEAGUE_AUDIT_MAX_AGE_HOURS;
  if (!policy) return null; // Default is a full audit; enabling a different boundary needs explicit policy.
  const hours = Number(policy);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168)
    throw new Error('Invalid approved audit schedule');
  return hours * 3600000;
}
export const pipelineAncestry = (source: string, viewer: string) =>
  ancestorOf(source, viewer, process.cwd());
export function pipelinePublicationOptions() {
  const viewer = publicHttp(requiredPipeline('PUBLICATION_VIEWER_URL'), 3600000);
  return {
    viewer: async () => JSON.parse((await viewer('build.json', 4096)).toString('utf8')) as unknown,
    worker: publicHttp(requiredPipeline('PUBLICATION_WORKER_URL'), 3600000),
    ancestor: pipelineAncestry,
    concurrency: 16,
    readConcurrency: 16,
    writeConcurrency: 16,
    headConcurrency: 16,
    maxInFlightBytes: 64 * 1024 ** 2,
    maxWorkerRequests: 1000,
  };
}
export async function pipelineDefinition() {
  const path = requiredPipeline('LEAGUE_DEFINITION');
  if (!/^data\/leagues\/[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/.test(path))
    throw new Error('Expected committed league definition');
  return cloudJson(path, undefined, 'INPUT_INVALID');
}
export async function localPipelineEvidence(context: PipelineContext, file: string) {
  const value = decodeLeagueCheckpoint(await readFile(join(context.root, file)));
  return PublicationEvidence.restore(value, {
    catalogHash: value.catalogHash,
    validatorDigest: context.identity.validatorDigest,
    now: Date.now(),
    maxAgeMs: pipelineAuditAge() ?? 3600000,
    authenticate: async (checkpoint) => {
      if (canonicalJson(checkpoint.identity) !== canonicalJson(context.identity))
        throw new Error('Local protected checkpoint identity mismatch');
    },
  });
}
