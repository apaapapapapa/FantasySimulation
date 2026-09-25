import {
  contentHash,
  leagueSlotCount,
  parseJson,
  SpecInputSchema,
  LeaguePartitionBodySchema,
  LeaguePlanBodySchema,
  LeaguePlanSchema,
  LeagueEstimateInputSchema,
  LeaguePartitionSchema,
  type LeagueDefinition,
  type LeaguePlan,
  type LeaguePartition,
  type LeagueProgress,
  type LeagueEstimateInput,
  type ExecutionSource,
  type BatchPlan,
} from '@fantasy/domain/spatial';
import {
  createLeagueRevision,
  leagueMatches,
  validateLeagueRevision,
} from '@fantasy/engine/spatial';
import { createBatchPlan, validateBatchPlan } from '../batch/batch-plan.ts';
import type { BattleBundles } from '../batch/battle-bundle.ts';
import { nextLeagueAttempt, verifyLeagueProgress } from './league-progress.ts';
import { canonicalJson } from '@fantasy/domain/spatial';

export function estimateLeague(
  definition: LeagueDefinition,
  input: LeagueEstimateInput,
  counts: { reused: number; retries: number; exhausted: number },
) {
  const options = LeagueEstimateInputSchema.parse(input),
    planned = leagueSlotCount(definition);
  if (
    Object.values(counts).some((n) => !Number.isSafeInteger(n) || n < 0) ||
    counts.reused + counts.exhausted > planned ||
    counts.retries > planned - counts.reused - counts.exhausted
  )
    throw new Error('Invalid league estimate counts');
  const compute = planned - counts.reused - counts.exhausted;
  const matchesPerPlan = Math.min(
    options.matchesPerPlan,
    Math.floor(1500000 / options.estimatedMsPerMatch),
  );
  if (matchesPerPlan < 1 || Math.ceil(planned / matchesPerPlan) > 512)
    throw new Error('League cannot fit bounded plans; revise the measured estimate');
  const partitions = Math.ceil(planned / matchesPerPlan);
  const estimatedBytes =
    options.retainedBytes + compute * options.estimatedBytesPerMatch + partitions * 2000000;
  const estimatedFiles =
    options.retainedFiles + compute * options.estimatedFilesPerMatch + partitions * 13 + 3;
  // Existing-object inspection and readback, plus object/page/catalog writes; conservative per-run ceiling.
  const readRequests =
    (counts.reused + compute) * options.estimatedFilesPerMatch * 2 + partitions * 26 + 6;
  const writeRequests = compute * options.estimatedFilesPerMatch + partitions * 13 + 3;
  if (
    estimatedBytes > 8000000000 ||
    estimatedFiles > 100000 ||
    readRequests + options.usedReadRequests > options.maxReadRequests ||
    writeRequests + options.usedWriteRequests > options.maxWriteRequests
  )
    throw new Error('League estimate exceeds storage, file or request budget');
  return {
    planned,
    ...counts,
    compute,
    newMatches: compute - counts.retries,
    partitions,
    matchesPerPlan,
    estimatedMs: compute * options.estimatedMsPerMatch,
    estimatedBytes,
    estimatedFiles,
    readRequests,
    writeRequests,
  };
}

export async function planLeague(
  input: unknown,
  source: ExecutionSource,
  options: LeagueEstimateInput,
  history: readonly LeagueProgress[] = [],
  bundles?: BattleBundles,
) {
  const revision = await createLeagueRevision(input, source.sha),
    progress = await verifyLeagueProgress(history, bundles);
  const generated: { partition: LeaguePartition; batch: BatchPlan }[] = [];
  const matches: {
    slot: LeaguePartition['slots'][number];
    spec: BatchPlan['slots'][number]['spec'];
  }[] = [];
  let reused = 0,
    retries = 0,
    exhausted = 0;
  for await (const { slot, manifest } of leagueMatches(revision)) {
    const prior = progress.get(slot.simulationHash),
      state = prior?.attempts.at(-1)?.state;
    if (state === 'win' || state === 'draw') reused++;
    else if (nextLeagueAttempt(prior) === 2) retries++;
    else if (nextLeagueAttempt(prior) === null) exhausted++;
    const { seed, participants, ruleset, scenario } = manifest;
    matches.push({ slot, spec: SpecInputSchema.parse({ seed, participants, ruleset, scenario }) });
  }
  const estimate = estimateLeague(revision.definition, options, { reused, retries, exhausted });
  for (let start = 0; start < matches.length; start += estimate.matchesPerPlan) {
    const entries = matches.slice(start, start + estimate.matchesPerPlan);
    const batch = await createBatchPlan(
      {
        schemaVersion: 1,
        revisions: revision.definition.revisions,
        matches: entries.map(({ slot, spec }) => ({ key: slot.id.slice(7), spec })),
        budget: revision.definition.budget,
        estimatedBytesPerMatch: options.estimatedBytesPerMatch,
        maxOutputBytes: Math.max(
          256 * 1024 ** 2,
          entries.length * options.estimatedBytesPerMatch + 4000000,
        ),
        maxWorkBytes: 512 * 1024 ** 2,
      },
      source,
    );
    const body = parseJson(LeaguePartitionBodySchema, {
      schemaVersion: 1,
      leagueHash: revision.leagueHash,
      index: generated.length,
      batchPlanId: batch.id,
      slots: entries.map((e) => e.slot),
    });
    generated.push({ partition: { ...body, id: await contentHash(body) }, batch });
  }
  const body = parseJson(LeaguePlanBodySchema, {
    schemaVersion: 1,
    revision,
    source,
    partitions: generated.map(({ partition, batch }) => ({
      partitionId: partition.id,
      batchPlanId: batch.id,
      slots: partition.slots.length,
    })),
  });
  return {
    plan: { ...body, id: await contentHash(body) } as LeaguePlan,
    partitions: generated,
    estimate,
  };
}

export async function validateLeaguePlan(input: unknown) {
  const plan = parseJson(LeaguePlanSchema, input),
    { id, ...body } = plan;
  await validateLeagueRevision(plan.revision);
  if (
    id !== (await contentHash(body)) ||
    plan.source.sha !== plan.revision.sourceSha ||
    plan.partitions.reduce((sum, p) => sum + p.slots, 0) !==
      leagueSlotCount(plan.revision.definition) ||
    new Set(plan.partitions.map((p) => p.partitionId)).size !== plan.partitions.length
  )
    throw new Error('League plan identity or coverage mismatch');
  return plan;
}

export async function validateLeaguePartition(
  plan: LeaguePlan,
  input: unknown,
  batchInput: unknown,
) {
  const partition = parseJson(LeaguePartitionSchema, input),
    { id, ...body } = partition;
  const ref = plan.partitions[partition.index];
  if (
    id !== (await contentHash(body)) ||
    partition.leagueHash !== plan.revision.leagueHash ||
    ref?.partitionId !== id ||
    ref.batchPlanId !== partition.batchPlanId ||
    ref.slots !== partition.slots.length
  )
    throw new Error('League partition identity mismatch');
  const batch = await validateBatchPlan(batchInput, plan.source);
  if (batch.id !== partition.batchPlanId || batch.slots.length !== partition.slots.length)
    throw new Error('League batch identity mismatch');
  const offset = plan.partitions.slice(0, partition.index).reduce((sum, p) => sum + p.slots, 0);
  const expected = new Map<
    string,
    { slot: LeaguePartition['slots'][number]; spec: BatchPlan['slots'][number]['spec'] }
  >();
  for await (const { slot, manifest } of leagueMatches(plan.revision, {
    offset,
    limit: partition.slots.length,
  })) {
    const { seed, participants, ruleset, scenario } = manifest;
    expected.set(slot.id, { slot, spec: { seed, participants, ruleset, scenario } });
  }
  const actualSlots = new Map(partition.slots.map((slot) => [slot.id, slot]));
  if (actualSlots.size !== expected.size)
    throw new Error('League partition slot coverage mismatch');
  for (const slot of batch.slots) {
    const entry = expected.get('sha256:' + slot.key);
    if (
      !entry ||
      canonicalJson(entry.slot) !== canonicalJson(actualSlots.get(entry.slot.id)) ||
      slot.simulationHash !== entry.slot.simulationHash ||
      canonicalJson(slot.spec) !== canonicalJson(entry.spec)
    )
      throw new Error('League partition manifest mismatch');
  }
  return { partition, batch };
}
