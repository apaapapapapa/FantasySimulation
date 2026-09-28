import { measureAsync } from '@fantasy/api/tooling';
import { OperationError, operationInput } from '@fantasy/api/tooling';
import { join } from 'node:path';
import {
  LeagueCloudInputSchema,
  LeagueCloudPreparedSchema,
  LeagueCloudInventorySchema,
  LeaguePartitionResultSchema,
  canonicalJson,
  PUBLICATION_MAX_BYTES,
  type ExecutionSource,
  type LeagueCloudInput,
} from '@fantasy/domain/spatial';
import { BattleBundles } from '@fantasy/api/artifacts';
import {
  planLeague,
  reserveLeaguePartition,
  runLeaguePartition,
  validateStoredLeaguePlan,
  type LeagueCheckInput,
} from '@fantasy/api/tooling';
import { localPublicationGraph } from '../publication/publication-graph.ts';
import {
  optionalPublicationFile,
  PUBLICATION_CONTROL_BYTES,
} from '../publication/publication-files.ts';
import { commitPublication } from '../publication/publication-catalog.ts';
import { buildLeagueWork, finishCheckedLeagueWork } from './league-work.ts';
import { exportLeague } from './league-export.ts';
import { LEAGUE_PROFILE, probeLeague, requireLeagueProbeBinding } from './league-probe.ts';
import { PublicReadFailure } from '../publication/publication-http.ts';
import { evidenceGraph, type PublicationEvidence } from '../publication/publication-evidence.ts';
import {
  cloudJson,
  writeCloudJson,
  cloudInput,
  preparedLeague,
  newCloudDirectory,
} from './league-cloud-files.ts';

export async function prepareCloudLeague(
  definition: unknown,
  source: ExecutionSource,
  executionId: string,
  publicRoot: string,
  preparedRoot: string,
  inventoryInput: unknown,
  expectedProbe?: unknown,
  options: { evidence?: PublicationEvidence; maxInputBytes?: number } = {},
) {
  const inventory = operationInput(
    () => LeagueCloudInventorySchema.parse(inventoryInput),
    'DATA_INVALID',
  );
  const graph = options.evidence
    ? evidenceGraph(options.evidence)
    : (await optionalPublicationFile(join(publicRoot, 'catalog/current.json'), 4000000))
      ? await localPublicationGraph(publicRoot)
      : null;
  const probe = await probeLeague(
    definition,
    source.sha,
    async (key, limit) => {
      const data = await optionalPublicationFile(join(publicRoot, key), limit);
      if (!data) throw new PublicReadFailure(404);
      return data;
    },
    'publish',
  );
  if (expectedProbe !== undefined) requireLeagueProbeBinding(expectedProbe, probe);
  const history = [...(graph?.latestWork?.records.values() ?? [])];
  const retained = new BattleBundles(publicRoot);
  const metadata = options.evidence?.bundles() ?? retained;
  const planned = await planLeague(
    definition,
    source,
    {
      ...LEAGUE_PROFILE,
      retainedBytes: inventory.bytes,
      retainedFiles: inventory.files,
      usedReadRequests: inventory.usedReadRequests,
      usedWriteRequests: inventory.usedWriteRequests,
    },
    history,
    metadata,
  );
  if (planned.partitions.length > 64)
    throw new OperationError(
      'BUDGET_EXCEEDED',
      'Actions league matrix limit; choose smaller definition',
    );
  const historyMap = new Map(history.map((record) => [record.simulationHash, record]));
  const reservations = [];
  for (const { partition } of planned.partitions) {
    const records = partition.slots.flatMap((slot) =>
      historyMap.has(slot.simulationHash) ? [historyMap.get(slot.simulationHash)!] : [],
    );
    reservations.push(
      await reserveLeaguePartition(planned.plan, partition, records, executionId, metadata),
    );
  }
  const work = await buildLeagueWork(
    planned.plan,
    planned.partitions,
    reservations,
    [],
    {
      ref: graph?.catalog.leagueWork ?? null,
      records: history,
    },
    executionId,
    metadata,
  );
  if (options.maxInputBytes !== undefined) {
    let bytes = 65536;
    for (const [index, { partition, batch }] of planned.partitions.entries()) {
      const reservation = reservations[index]!;
      bytes += Buffer.byteLength(
        canonicalJson({
          schemaVersion: 1,
          plan: planned.plan,
          partition,
          batch,
          reservation,
          work: work.ref,
        }),
      );
      const hashes = new Set(
        reservation.progress.records.flatMap((record) =>
          record.attempts.flatMap((attempt) => (attempt.objectHash ? [attempt.objectHash] : [])),
        ),
      );
      for (const hash of hashes) {
        const proof = [...(graph?.replays.values() ?? [])].find(
          (p) => p.receipt.objectHash === hash,
        );
        if (!proof) throw new OperationError('DATA_INVALID', 'Missing retained input evidence');
        bytes += proof.logical.reduce((n, file) => n + file.bytes, 0);
      }
    }
    if (!Number.isSafeInteger(options.maxInputBytes) || bytes > options.maxInputBytes)
      throw new OperationError(
        'BUDGET_EXCEEDED',
        'Shared input archive requires the legacy bounded workflow',
      );
  }
  await newCloudDirectory(preparedRoot);
  const inputs = [];
  for (const [index, { partition, batch }] of planned.partitions.entries()) {
    const reservation = reservations[index]!;
    const input = LeagueCloudInputSchema.parse({
      schemaVersion: 1,
      plan: planned.plan,
      partition,
      batch,
      reservation,
      work: work.ref,
    });
    const directory = join(preparedRoot, 'inputs', String(index));
    inputs.push(await writeCloudJson(join(directory, 'input.json'), input));
    const cache = new BattleBundles(join(directory, 'retained'), batch.maxOutputBytes);
    const hashes = new Set(
      reservation.progress.records.flatMap((record) =>
        record.attempts.flatMap((attempt) => (attempt.objectHash ? [attempt.objectHash] : [])),
      ),
    );
    for (const hash of hashes) await cache.importRecorded(retained, hash);
  }
  const prepared = LeagueCloudPreparedSchema.parse({
    schemaVersion: 1,
    plan: planned.plan,
    executionId,
    work: work.ref,
    inputs,
  });
  await writeCloudJson(join(preparedRoot, 'prepared.json'), prepared);
  await writeCloudJson(join(preparedRoot, 'estimate.json'), planned.estimate);
  await commitPublication(publicRoot, work.files, [], {
    leagueWork: work.ref,
    maxBytes: PUBLICATION_MAX_BYTES - PUBLICATION_CONTROL_BYTES,
  });
  return { prepared, estimate: planned.estimate };
}

function assertCloudSource(input: LeagueCloudInput, source: ExecutionSource, executionId: string) {
  if (
    input.reservation.executionId !== executionId ||
    canonicalJson(input.plan.source) !== canonicalJson(source)
  )
    throw new OperationError(
      'IDENTITY_MISMATCH',
      'Cloud source/execution mismatch; start a new complete workflow run',
      input.partition.id,
    );
}
export async function runCloudLeague(
  inputRoot: string,
  outputRoot: string,
  source: ExecutionSource,
  executionId: string,
  signal?: AbortSignal,
  options: {
    pool?: import('@fantasy/api/tooling').BattlePool;
    workers?: number;
    deadlineMs?: number;
  } = {},
) {
  const input = LeagueCloudInputSchema.parse(await cloudJson(join(inputRoot, 'input.json')));
  assertCloudSource(input, source, executionId);
  const result = await runLeaguePartition(
    input.plan,
    input.partition,
    input.batch,
    input.reservation,
    outputRoot,
    source,
    executionId,
    {
      ...options,
      workers: options.workers ?? options.pool?.workers ?? 2,
      deadlineMs: options.deadlineMs ?? 1500000,
      retained: new BattleBundles(join(inputRoot, 'retained')),
      ...(signal ? { signal } : {}),
    },
  );
  await writeCloudJson(join(outputRoot, 'result.json'), result);
  return { elapsedMs: result.elapsedMs, complete: result.index.complete, resultId: result.id };
}

export async function finishCloudLeague(
  preparedRoot: string,
  resultRoot: string,
  publicRoot: string,
  source: ExecutionSource,
  executionId: string,
  options: { verificationWorkers?: number; signal?: AbortSignal; packs?: boolean } = {},
) {
  return measureAsync('aggregate.final', async () => {
    options.signal?.throwIfAborted();
    const prepared = await preparedLeague(preparedRoot);
    await validateStoredLeaguePlan(prepared.plan);
    if (
      prepared.executionId !== executionId ||
      canonicalJson(prepared.plan.source) !== canonicalJson(source)
    )
      throw new OperationError('IDENTITY_MISMATCH', 'Cloud finalizer identity mismatch');
    const graph = await localPublicationGraph(
      publicRoot,
      options.verificationWorkers ?? 2,
      options.signal,
    );
    if (!graph.latestWork || graph.catalog.leagueWork?.hash !== prepared.work.hash)
      throw new OperationError('IDENTITY_MISMATCH', 'Cloud reservation journal mismatch');
    const inputs: LeagueCloudInput[] = [],
      completed: LeagueCheckInput[] = [];
    for (let index = 0; index < prepared.inputs.length; index++) {
      const input = await cloudInput(preparedRoot, prepared, index);
      assertCloudSource(input, source, executionId);
      inputs.push(input);
      const path = join(resultRoot, String(index), 'result.json');
      if (!(await optionalPublicationFile(path, 16000000))) continue;
      const result = LeaguePartitionResultSchema.parse(await cloudJson(path));
      completed.push({
        partition: input.partition,
        batch: input.batch,
        reservation: input.reservation,
        result,
        bundles: new BattleBundles(join(resultRoot, String(index), 'bundles')),
      });
    }
    const reserved = {
      ref: prepared.work,
      work: graph.latestWork.work,
      records: [...graph.latestWork.records.values()],
    };
    const exported = await exportLeague(
      prepared.plan,
      inputs,
      completed,
      publicRoot,
      (checked) =>
        finishCheckedLeagueWork(
          checked,
          inputs.map((input) => input.reservation),
          reserved,
          new BattleBundles(publicRoot),
        ),
      {
        verificationWorkers: options.verificationWorkers ?? 2,
        packs: options.packs ?? false,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    await writeCloudJson(join(preparedRoot, 'completion.json'), {
      ...exported,
      receivedPartitions: completed.length,
      elapsedMs: completed.map(
        (entry) => LeaguePartitionResultSchema.parse(entry.result).elapsedMs,
      ),
    });
    return exported;
  });
}
