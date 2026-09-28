import { OperationError, operationInput } from '../operation-error.ts';
import {
  BatchIndexSchema,
  BatchPlanSchema,
  canonicalJson,
  contentHash,
  parseJson,
  type BatchPlan,
  type BatchIndex,
} from '@fantasy/domain/spatial';
import type { BundleRead } from './battle-bundle.ts';
import type { ReplayVerifier } from '../replay/verification-pool.ts';

export type BatchCheckInput = { index: unknown; bundles: BundleRead };
export function shardSlots(plan: BatchPlan, index: number, count: number) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 64 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count
  )
    throw new Error('Invalid bounded shard selection');
  return plan.slots.filter((slot) => Number.parseInt(slot.id.slice(7, 15), 16) % count === index);
}

export async function checkedBatch(
  input: unknown,
  indexes: BatchCheckInput[],
  verification?: { publicData?: boolean; pool?: ReplayVerifier; signal?: AbortSignal },
) {
  if (indexes.length > 64) throw new Error('Expected at most 64 batch indexes');
  const scoped = verification
    ? indexes.map((value) => ({
        index: value.index,
        bundles: value.bundles.verificationSession(verification),
      }))
    : indexes;
  try {
    const checked = await checkBatchData(input, scoped, verification !== undefined);
    if (verification) {
      const originals = new Map(scoped.map((value, i) => [value.bundles, indexes[i]!.bundles]));
      for (const [slot, bundles] of checked.sources)
        checked.sources.set(slot, originals.get(bundles)!);
    }
    return checked;
  } finally {
    if (verification) scoped.forEach((value) => value.bundles.closeVerification());
  }
}

async function checkBatchData(input: unknown, indexes: BatchCheckInput[], preverify: boolean) {
  const plan = parseJson(BatchPlanSchema, input);
  const { id: planId, ...planBody } = plan;
  if (planId !== (await contentHash(planBody))) throw new Error('Plan checksum mismatch');
  const revisionKeys = new Set<string>();
  for (const revision of plan.revisions) {
    const key = `${revision.kind}:${revision.id}:${revision.revision}`;
    if (
      revisionKeys.has(key) ||
      revision.contentHash !==
        (await contentHash({
          kind: revision.kind,
          schemaVersion: revision.schemaVersion,
          definition: revision.definition,
        }))
    )
      throw new Error('Plan revision identity mismatch');
    revisionKeys.add(key);
  }
  const identities = new Set<string>(),
    keys = new Set<string>();
  for (const slot of plan.slots) {
    if (
      identities.has(slot.simulationHash) ||
      keys.has(slot.key) ||
      slot.id !== (await contentHash({ key: slot.key, simulationHash: slot.simulationHash }))
    )
      throw new Error('Plan slot identity mismatch');
    identities.add(slot.simulationHash);
    keys.add(slot.key);
    for (const [kind, ref] of [
      ['ruleset', slot.spec.ruleset],
      ['scenario', slot.spec.scenario],
      ...slot.spec.participants.map((p) => ['character', p.character] as const),
    ] as const) {
      if (
        !plan.revisions.some(
          (r) =>
            r.kind === kind &&
            r.id === ref.id &&
            r.revision === ref.revision &&
            r.contentHash === ref.contentHash,
        )
      )
        throw new Error('Plan definition reference mismatch');
    }
  }
  const expected = new Map(plan.slots.map((s) => [s.id, s.simulationHash]));
  const sources = new Map<string, BundleRead>();
  const shardIds = new Set<number>();
  let shardCount: number | undefined;
  const found = new Map<string, BatchIndex['slots'][number]>();
  const pending: { bundles: BundleRead; slots: BatchIndex['slots'] }[] = [];
  for (const value of indexes) {
    const index = operationInput(() => parseJson(BatchIndexSchema, value.index), 'DATA_INVALID'),
      { id, ...body } = index;
    if (
      index.planId !== plan.id ||
      canonicalJson(index.source) !== canonicalJson(plan.source) ||
      id !== (await contentHash(body))
    )
      throw new OperationError('DATA_INVALID', 'Batch index identity mismatch');
    if (
      (shardCount !== undefined && shardCount !== index.shardCount) ||
      shardIds.has(index.shardIndex)
    )
      throw new OperationError('DATA_INVALID', 'Mixed or duplicate shard declarations');
    shardCount = index.shardCount;
    shardIds.add(index.shardIndex);
    const selected = new Set(shardSlots(plan, index.shardIndex, index.shardCount).map((s) => s.id));
    if (
      index.slots.length !== selected.size ||
      index.complete !== index.slots.every((s) => s.state === 'complete')
    )
      throw new OperationError('DATA_INVALID', 'Incomplete or inconsistent shard declaration');
    for (const slot of index.slots) {
      if (
        !selected.has(slot.slotId) ||
        expected.get(slot.slotId) !== slot.simulationHash ||
        found.has(slot.slotId)
      )
        throw new OperationError('DATA_INVALID', 'Missing, duplicate or unexpected planned slot');
      found.set(slot.slotId, slot);
      sources.set(slot.slotId, value.bundles);
      if (slot.receipt && slot.receipt.simulationHash !== slot.simulationHash)
        throw new OperationError('DATA_INVALID', 'Index replay reference mismatch');
      const outcome = slot.receipt?.result.outcome.kind;
      if (
        (slot.reused && slot.state !== 'complete') ||
        ((slot.state === 'unresolved' || slot.state === 'truncated') && outcome !== slot.state) ||
        ((slot.state === 'failed' || slot.state === 'pending') && slot.receipt !== null)
      )
        throw new OperationError('DATA_INVALID', 'Slot state/replay mismatch');
      if (
        slot.state === 'complete' &&
        (!slot.receipt || !['win', 'draw'].includes(slot.receipt.result.outcome.kind))
      )
        throw new OperationError(
          'DATA_INVALID',
          'Unverified or nondefinitive slot cannot be complete',
        );
    }
    pending.push({ bundles: value.bundles, slots: index.slots });
  }
  // Validate all identities before admitting CPU work. Windows fit the session hash bound.
  for (const { bundles, slots } of pending) {
    for (let offset = 0; offset < slots.length; offset += 128) {
      const window = slots.slice(offset, offset + 128);
      if (preverify)
        await bundles.preverify(
          window.flatMap((slot) => (slot.receipt ? [slot.receipt.objectHash] : [])),
        );
      for (const slot of window) {
        if (
          slot.receipt &&
          canonicalJson(await bundles.verify(slot.receipt.objectHash)) !==
            canonicalJson(slot.receipt)
        )
          throw new OperationError('DATA_INVALID', 'Index replay reference mismatch');
      }
    }
  }
  const summary = {
    planned: expected.size,
    recorded: found.size,
    complete:
      found.size === expected.size && [...found.values()].every((s) => s.state === 'complete'),
    missing: [...expected.keys()].filter((id) => !found.has(id)),
  };
  return { plan, found, sources, summary };
}

export async function reconcileBatch(input: unknown, indexes: BatchCheckInput[]) {
  return (await checkedBatch(input, indexes)).summary;
}
