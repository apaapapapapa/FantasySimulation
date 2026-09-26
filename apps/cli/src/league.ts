import { parseArgs } from 'node:util';
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { canonicalJson, LeagueEstimateInputSchema, type LeaguePlan } from '@fantasy/domain/spatial';
import { BattleBundles, readBoundedFile, publishImmutableFile } from '@fantasy/api/artifacts';
import {
  planLeague,
  validateLeaguePlan,
  validateStoredLeaguePlan,
  reserveLeaguePartition,
  runLeaguePartition,
  checkStoredLeague,
  executionSource,
  type LeagueCheckInput,
} from '@fantasy/api/tooling';
import { readLeagueHistory } from './league/league-history.ts';

const readJson = async (path: string, limit = 4000000): Promise<unknown> =>
  JSON.parse((await readBoundedFile(resolve(path), limit)).toString('utf8'));
async function writeJson(path: string, input: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await publishImmutableFile(path, canonicalJson(input));
}
async function immutableJson(directory: string) {
  const files = await readdir(directory);
  if (files.length !== 1 || !/^[0-9a-f]{64}[.]json$/.test(files[0]!))
    throw new Error('Expected exactly one immutable document');
  return readJson(join(directory, files[0]!));
}
async function partitionAt(directory: string, plan: LeaguePlan, index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= plan.partitions.length)
    throw new Error('Invalid partition index');
  const ref = plan.partitions[index]!;
  return {
    partition: await readJson(join(directory, 'partitions', ref.partitionId.slice(7) + '.json')),
    batch: await readJson(join(directory, 'batches', ref.batchPlanId.slice(7) + '.json')),
  };
}
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: 'string' },
      history: { type: 'string' },
      retained: { type: 'string' },
      'estimate-only': { type: 'boolean' },
      'execution-id': { type: 'string' },
      reservation: { type: 'string' },
      workers: { type: 'string' },
      deadline: { type: 'string' },
    },
  });
  const [command, input, output, ...rest] = positionals;
  const retained = values.retained ? new BattleBundles(resolve(values.retained)) : undefined;
  if (command === 'plan' && input && output && !rest.length) {
    const options = LeagueEstimateInputSchema.parse(
      values.profile
        ? await readJson(values.profile)
        : {
            matchesPerPlan: 128,
            estimatedMsPerMatch: 4000,
            estimatedBytesPerMatch: 250000,
            estimatedFilesPerMatch: 12,
            retainedBytes: 0,
            retainedFiles: 0,
            maxReadRequests: 10000000,
            maxWriteRequests: 1000000,
            usedReadRequests: 0,
            usedWriteRequests: 0,
          },
    );
    const result = await planLeague(
      await readJson(input),
      executionSource(),
      options,
      await readLeagueHistory(values.history),
      retained,
    );
    console.log(canonicalJson(result.estimate));
    if (values['estimate-only']) return;
    for (const { partition, batch } of result.partitions) {
      await writeJson(resolve(output, 'partitions', partition.id.slice(7) + '.json'), partition);
      await writeJson(resolve(output, 'batches', batch.id.slice(7) + '.json'), batch);
    }
    await writeJson(resolve(output, 'league.json'), result.plan);
  } else if (
    (command === 'reserve' || command === 'run') &&
    input &&
    output &&
    rest.length === 1 &&
    values['execution-id']
  ) {
    const directory = resolve(input),
      plan = await validateLeaguePlan(await readJson(join(directory, 'league.json')));
    const index = Number(output),
      files = await partitionAt(directory, plan, index);
    if (command === 'reserve') {
      const { validateLeaguePartition } = await import('@fantasy/api/tooling');
      const { partition } = await validateLeaguePartition(plan, files.partition, files.batch);
      const reservation = await reserveLeaguePartition(
        plan,
        partition,
        await readLeagueHistory(values.history),
        values['execution-id'],
        retained,
      );
      await writeJson(resolve(rest[0]!), reservation);
      console.log(
        canonicalJson({ reservationId: reservation.id, progress: reservation.progress.id }),
      );
    } else {
      if (!values.reservation) throw new Error('Run requires a persisted reservation');
      const controller = new AbortController(),
        stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        const result = await runLeaguePartition(
          plan,
          files.partition,
          files.batch,
          await readJson(values.reservation),
          resolve(rest[0]!),
          executionSource(),
          values['execution-id'],
          {
            workers: Number(values.workers ?? 1),
            deadlineMs: Number(values.deadline ?? 1500000),
            signal: controller.signal,
            ...(retained ? { retained } : {}),
          },
        );
        console.log(
          canonicalJson({
            id: result.id,
            complete: result.index.complete,
            elapsedMs: result.elapsedMs,
          }),
        );
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
    }
  } else if (
    (command === 'check' || command === 'export') &&
    input &&
    output &&
    rest.length === (command === 'export' ? 1 : 0)
  ) {
    const directory = resolve(input),
      plan = await validateStoredLeaguePlan(await readJson(join(directory, 'league.json'))),
      partitions = [],
      completed: LeagueCheckInput[] = [];
    for (let i = 0; i < plan.partitions.length; i++) {
      const partition = await partitionAt(directory, plan, i);
      partitions.push(partition);
      const root = resolve(output, String(i));
      let result: unknown;
      try {
        result = await immutableJson(join(root, 'results'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      completed.push({
        ...partition,
        reservation: await immutableJson(join(root, 'reservations')),
        result,
        bundles: new BattleBundles(join(root, 'bundles')),
      });
    }
    if (command === 'export') {
      const { exportLeague } = await import('./league/league-export.ts');
      console.log(
        canonicalJson(await exportLeague(plan, partitions, completed, resolve(rest[0]!))),
      );
      return;
    }
    const result = await checkStoredLeague(plan, partitions, completed);
    console.log(
      canonicalJson({
        status: result.standings.status,
        planned: result.standings.planned,
        resolved: result.standings.resolved,
        missingPartitions: result.missingPartitions,
      }),
    );
  } else
    throw new Error(
      'Usage: league plan definition.json plan-dir [--estimate-only --profile profile.json --history dir --retained bundles] | reserve plan-dir partition reservation.json --execution-id ID [--history dir --retained bundles] | run plan-dir partition output-dir --execution-id ID --reservation file [--retained bundles --workers 1 --deadline 1500000] | check plan-dir results-dir | export plan-dir results-dir public-dir',
    );
}
await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
