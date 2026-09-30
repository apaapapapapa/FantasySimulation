import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { HashSchema, LeagueCostProfileSchema, canonicalJson } from '@fantasy/domain/spatial';
import { cloudJson } from '../apps/cli/src/league/league-cloud-files.ts';
import { PipelineArtifacts } from './league-pipeline-artifacts.ts';
import { requireArtifactPilot, requireFreshWorkerProfile } from './league-pipeline-policy.ts';
import type { PipelineContext } from './league-pipeline-context.ts';

/** The reviewed hash selects measured bytes from a successful exact-source Worker pilot. */
export async function measuredPipelineProfile(
  context: Pick<PipelineContext, 'github' | 'token' | 'identity' | 'root'>,
  runId: number,
  measurementHash: string,
) {
  HashSchema.parse(measurementHash);
  const run = await requireArtifactPilot(context.github, runId);
  const github = new PipelineArtifacts(
    context.token,
    { ...context.identity, runId, runAttempt: run.run_attempt },
    4,
    'league-pilot.yml',
  );
  const name = `league-${runId}-${run.run_attempt}-cost-profile`;
  const [artifact] = await github.list(name);
  if (!artifact) throw new Error('Missing authenticated Worker cost profile');
  const root = join(context.root, 'measured-profile');
  try {
    await github.download(artifact, root, (key) => key === 'cost-profile.json');
    const profile = LeagueCostProfileSchema.parse(await cloudJson(join(root, 'cost-profile.json')));
    if (
      canonicalJson(profile.source) !== canonicalJson(context.identity.source) ||
      profile.measurementHash !== measurementHash
    )
      throw new Error('Measured cost profile source or reviewed hash mismatch');
    requireFreshWorkerProfile(run.workerMeasuredAt);
    return profile;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
