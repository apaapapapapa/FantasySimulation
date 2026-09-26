import {
  canonicalJson,
  revisionKey,
  LeaguePartitionSchema,
  BatchPlanSchema,
  type BatchPlan,
  type BundleReceipt,
  type LeagueSlot,
} from '@fantasy/domain/spatial';
import { leagueCoordinates } from '@fantasy/engine/spatial';
import { checkedBatch } from '../batch/batch-check.ts';
import type { BattleBundles } from '../batch/battle-bundle.ts';
import { OperationError } from '../operation-error.ts';
import { leaguePartitionIdentity, validateStoredLeaguePlan } from './league-plan.ts';

/** All original partitions are required: missing results never remove scheduled slots. */
export async function storedLeagueInputs(
  input: unknown,
  inputs: readonly { partition: unknown; batch: unknown }[],
) {
  const plan = await validateStoredLeaguePlan(input);
  if (inputs.length !== plan.partitions.length)
    throw new OperationError('DATA_INVALID', 'Missing league partition definition');
  const expected = new Map<
    string,
    {
      ordinal: number;
      slot: Omit<LeagueSlot, 'simulationHash'>;
      spec: BatchPlan['slots'][number]['spec'];
    }
  >();
  for await (const entry of leagueCoordinates(plan.revision.definition))
    expected.set(entry.slot.id, { ...entry, ordinal: expected.size });
  const partitions = new Map<
    number,
    {
      partition: Awaited<ReturnType<typeof leaguePartitionIdentity>>;
      batch: BatchPlan;
    }
  >();
  const slots: LeagueSlot[] = [],
    hashes = new Set<string>(),
    seen = new Set<string>();
  for (const entry of inputs) {
    const partition = await leaguePartitionIdentity(plan, entry.partition);
    const batch = (await checkedBatch(entry.batch, [])).plan;
    if (partitions.has(partition.index))
      throw new OperationError('DATA_INVALID', 'Duplicate league partition definition');
    if (
      batch.id !== partition.batchPlanId ||
      batch.slots.length !== partition.slots.length ||
      canonicalJson(batch.source) !== canonicalJson(plan.source) ||
      batch.engineVersion !== plan.revision.engineVersion ||
      batch.implementationDigest !== plan.revision.implementationDigest ||
      canonicalJson(batch.revisions) !== canonicalJson(plan.revision.definition.revisions)
    )
      throw new OperationError('IDENTITY_MISMATCH', 'Stored league batch identity mismatch');
    const offset = plan.partitions
      .slice(0, partition.index)
      .reduce((sum, part) => sum + part.slots, 0);
    const batchSlots = new Map(batch.slots.map((slot) => [slot.key, slot]));
    for (const slot of partition.slots) {
      const coordinate = expected.get(slot.id),
        batchSlot = batchSlots.get(slot.id.slice(7));
      const { simulationHash, ...value } = slot;
      if (
        !coordinate ||
        !batchSlot ||
        seen.has(slot.id) ||
        hashes.has(simulationHash) ||
        coordinate.ordinal < offset ||
        coordinate.ordinal >= offset + partition.slots.length ||
        canonicalJson(value) !== canonicalJson(coordinate.slot) ||
        canonicalJson(batchSlot.spec) !== canonicalJson(coordinate.spec) ||
        simulationHash !== batchSlot.simulationHash
      )
        throw new OperationError('IDENTITY_MISMATCH', 'Stored league partition manifest mismatch');
      seen.add(slot.id);
      hashes.add(simulationHash);
      slots.push(slot);
    }
    partitions.set(partition.index, { partition, batch });
  }
  if (seen.size !== expected.size)
    throw new OperationError('IDENTITY_MISMATCH', 'Stored league slot coverage mismatch');
  return { plan, slots, partitions };
}

export function storedResultPartition(
  stored: Awaited<ReturnType<typeof storedLeagueInputs>>,
  entry: { partition: unknown; batch: unknown },
) {
  const partition = LeaguePartitionSchema.parse(entry.partition),
    batch = BatchPlanSchema.parse(entry.batch),
    original = stored.partitions.get(partition.index);
  if (!original || canonicalJson({ partition, batch }) !== canonicalJson(original))
    throw new OperationError('IDENTITY_MISMATCH', 'Result differs from stored league partition');
  return original;
}

/** Bind an already verified recording to its original plan, without preparing a battle. */
export function storedLeagueBundleBinding(batch: BatchPlan, bundles: BattleBundles) {
  const revisions = new Map(
    batch.revisions.map((revision) => [revisionKey(revision), revision.contentHash]),
  );
  return async (slot: BatchPlan['slots'][number], receipt: BundleReceipt) => {
    const { input } = await bundles.manifest(receipt);
    if (
      input.engineVersion !== batch.engineVersion ||
      input.implementationDigest !== batch.implementationDigest ||
      canonicalJson({
        seed: input.seed,
        participants: input.participants,
        ruleset: input.ruleset,
        scenario: input.scenario,
      }) !== canonicalJson(slot.spec) ||
      input.revisions.some(
        (revision) => revisions.get(revisionKey(revision)) !== revision.contentHash,
      )
    )
      throw new OperationError('DATA_INVALID', 'Stored league recording and plan mismatch');
  };
}
