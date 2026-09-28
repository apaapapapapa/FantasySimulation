import { OperationError } from '@fantasy/api/artifacts';
import { canonicalJson, type LeaguePlan } from '@fantasy/domain/spatial';

/** Scheduling hints are outside the immutable plan, simulation and reservation identities. */
export function assignLeagueRunners(
  plan: LeaguePlan,
  runners: number,
  costs: ReadonlyMap<string, number> = new Map(),
) {
  if (!Number.isInteger(runners) || runners < 1 || runners > 32 || plan.partitions.length > 64)
    throw new OperationError('INPUT_INVALID', 'League runner/partition bound');
  const partitions = plan.partitions.map((partition, index) => {
    const cost = costs.get(partition.partitionId) ?? partition.slots;
    if (!Number.isSafeInteger(cost) || cost < 1)
      throw new OperationError('INPUT_INVALID', 'Invalid measured partition cost');
    return { index, id: partition.partitionId, cost };
  });
  if (
    new Set(partitions.map((p) => p.id)).size !== partitions.length ||
    [...costs.keys()].some((id) => !partitions.some((p) => p.id === id))
  )
    throw new OperationError('INPUT_INVALID', 'Unknown or duplicate assignment partition');
  partitions.sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id));
  const assignments = Array.from({ length: Math.min(runners, partitions.length) }, (_, runner) => ({
    runner,
    partitions: [] as number[],
    cost: 0,
  }));
  for (const partition of partitions) {
    const target = assignments.reduce((a, b) => (b.cost < a.cost ? b : a));
    target.partitions.push(partition.index);
    target.cost += partition.cost;
    if (!Number.isSafeInteger(target.cost))
      throw new OperationError('INPUT_INVALID', 'Assignment cost overflow');
  }
  return assignments;
}

export function requireLeagueAssignment(
  plan: LeaguePlan,
  input: unknown,
  runners: number,
  costs: ReadonlyMap<string, number> = new Map(),
) {
  const expected = assignLeagueRunners(plan, runners, costs);
  if (canonicalJson(input) !== canonicalJson(expected))
    throw new OperationError('IDENTITY_MISMATCH', 'League runner assignment mismatch');
  return expected;
}
