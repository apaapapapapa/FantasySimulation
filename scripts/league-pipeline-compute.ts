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
) {
  const prefix = `league-${identity.runId}-${identity.runAttempt}`;
  const all = await github.list(prefix + '-inputs'),
    input = all.find((a) => a.name === prefix + '-inputs');
  if (!input) throw new Error('Missing immutable shared input');
  const preparedRoot = join(root, 'prepared');
  await github.download(input, preparedRoot, pipelineInputKey);
  const control = LeaguePipelineControlSchema.parse(
    await cloudJson(join(preparedRoot, 'control.json')),
  );
  if (canonicalJson(control.identity) !== canonicalJson(identity))
    throw new Error('Shared input identity mismatch');
  const prepared = await preparedLeague(preparedRoot),
    artifacts: PipelineArtifact[] = [];
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
        const controls = ['proof.json', 'result.json'].map((name) => join(producerRoot, name));
        const controlBytes = (await Promise.all(controls.map((path) => lstat(path)))).reduce(
          (n, info) => n + info.size,
          0,
        );
        const groups = producerArtifactGroups(proof.files, controlBytes);
        if (groups.length > 3 || artifacts.length + groups.length > 30)
          throw new Error('Producer artifact quota exceeded');
        for (const [part, files] of groups.entries())
          artifacts.push(
            await uploadPipelineArtifact(
              `${prefix}-runner-${runner}-partition-${index}-part-${part}-of-${groups.length}`,
              [...controls, ...files.map((file) => join(producerRoot, 'public', file.key))],
              producerRoot,
            ),
          );
        await rm(producerRoot, { recursive: true });
        await rm(directory, { recursive: true });
      },
    },
  );
  await writeCloudJson(join(root, 'terminal.json'), {
    schemaVersion: 1,
    identity,
    runner,
    partitions: outcome.assignment.partitions,
    artifacts,
  });
  await uploadPipelineArtifact(`${prefix}-terminal-${runner}`, [join(root, 'terminal.json')], root);
  return { ...outcome, artifactCount: artifacts.length + 1, metadata: github.metrics() };
}
