import { join, resolve } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { Measurements } from '@fantasy/api/tooling';
import { canonicalJson, contentHash, LeagueDefinitionSchema } from '@fantasy/domain/spatial';
import {
  cloudJson,
  cloudInput,
  writeCloudJson,
} from '../apps/cli/src/league/league-cloud-files.ts';
import { prepareCloudLeague } from '../apps/cli/src/league/league-cloud.ts';
import { runCloudLeagueRunner } from '../apps/cli/src/league/league-runner.ts';
import { sealLeagueProducer } from '../apps/cli/src/league/league-producer.ts';
import {
  PublicationEvidence,
  evidenceGraph,
} from '../apps/cli/src/publication/publication-evidence.ts';
import { leagueCostProfile } from '../apps/cli/src/league/league-cost-profile.ts';
import { pipelineContext } from './league-pipeline-context.ts';

const root = resolve('.generated/league-worker-pilot');
await mkdir(root, { recursive: true });
const context = await pipelineContext(root);
const original = LeagueDefinitionSchema.parse(await cloudJson('data/leagues/official-20-v2.json'));
const definition = {
  ...original,
  characters: original.characters.filter((c) => ['guardian', 'fire-mage'].includes(c.id)),
  trials: 1,
};
if (definition.characters.length !== 2 || definition.battlefields.length !== 5)
  throw new Error('Pilot input changed');
const registration = {
  schemaVersion: 1,
  identity: context.identity,
  definitionHash: await contentHash(definition),
  definition,
  warmups: 1,
  pairedTrials: 5,
  workers: [2, 3, 4],
  matchesPerTrial: 10,
  reuse: 0,
  order: Array.from({ length: 6 }, (_, i) => [2, 3, 4].map((_, j) => [2, 3, 4][(i + j) % 3])),
  timing:
    'Process wall includes pool startup, simulation, independent public verification and packing; overlapping spans are not summed.',
};
await writeCloudJson(join(root, 'registration.json'), registration);
const matches: ReturnType<Measurements['report']>['matches'] = [],
  failures: unknown[] = [];
let expected: string | undefined;
for (let trial = 0; trial < 6; trial++)
  for (const workers of registration.order[trial]!) {
    const directory = join(root, `trial-${trial}-workers-${workers}`),
      measurement = new Measurements();
    const sample = setInterval(() => measurement.sample(), 250);
    sample.unref();
    let status = 'failed';
    try {
      await measurement.run(async () => {
        const preparedRoot = join(directory, 'prepared');
        const { prepared } = await prepareCloudLeague(
          definition,
          context.identity.source,
          context.prefix,
          join(directory, 'baseline'),
          preparedRoot,
          { files: 0, bytes: 0, receipts: 0, usedReadRequests: 10000, usedWriteRequests: 10000 },
        );
        const outcomes: unknown[] = [];
        await runCloudLeagueRunner(
          preparedRoot,
          join(directory, 'results'),
          context.identity.source,
          context.prefix,
          {
            runner: 0,
            runners: 1,
            workers: workers!,
            comparisonWorkers: true,
            completed: async (index, resultRoot, pool, bundles) => {
              const producer = join(directory, 'producer-' + index);
              await sealLeagueProducer(
                await cloudInput(preparedRoot, prepared, index),
                resultRoot,
                producer,
                context.identity,
                0,
                pool,
                bundles,
              );
              const graph = evidenceGraph(
                await PublicationEvidence.producer(join(producer, 'public'), async () => {}),
              );
              outcomes.push(
                ...[...graph.replays.values()].map((p) => ({
                  simulationHash: p.receipt.simulationHash,
                  result: p.receipt.result,
                  chunks: p.manifest.chunks,
                  checkpoints: p.manifest.checkpoints,
                })),
              );
            },
          },
        );
        const signature = canonicalJson(
          outcomes.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
        );
        await writeFile(join(root, `signature-${trial}-${workers}.json`), signature, {
          flag: 'wx',
        });
        if (expected !== undefined && signature !== expected)
          throw new Error('Paired result/replay checksum mismatch');
        expected ??= signature;
      });
      const report = measurement.report();
      if (
        report.matches.length !== 10 ||
        report.matches.some((m) => !m.worker || !['win', 'draw'].includes(m.outcome))
      )
        throw new Error('Pilot requires ten newly computed definitive results');
      if (workers === 2 && trial > 0) matches.push(...report.matches);
      status = 'completed';
    } catch (error) {
      failures.push({
        trial,
        workers,
        error: error instanceof Error ? error.message : 'Unknown pilot failure',
      });
    } finally {
      clearInterval(sample);
      await writeCloudJson(join(root, `measurement-${trial}-${workers}.json`), {
        ...measurement.report(),
        trial,
        workers,
        status,
      });
      if (status === 'completed') await rm(directory, { recursive: true });
    }
  }
await writeCloudJson(join(root, 'failures.json'), failures);
if (failures.length || matches.length !== 50)
  throw new Error('Worker pilot is incomplete; retain every failure');
await writeCloudJson(
  join(root, 'cost-profile.json'),
  await leagueCostProfile(context.identity.source, matches),
);
await writeFile(join(root, 'result-signature.json'), expected!);
