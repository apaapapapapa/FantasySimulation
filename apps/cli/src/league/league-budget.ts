import { OperationError, operationInput } from '@fantasy/api/tooling';
import {
  LeagueUsageSchema,
  CycleLeagueUsageSchema,
  LeagueBillingObservationSchema,
  LeagueUsageLeaseSchema,
  canonicalJson,
  type LeagueUsage,
  type LeagueUsageLease,
  type LeagueBillingObservation,
} from '@fantasy/domain/spatial';
import type { RemoteObject } from '../publication/publication-remote.ts';
import { PUBLICATION_CONTROL_BYTES } from '../publication/publication-files.ts';

export const LEAGUE_USAGE_LIMITS = { classA: 900000, classB: 9000000, worker: 90000 } as const;
const CONTROL_RESERVE = 10000;
const OBSERVATION_MAX_AGE_MS = 3600000;

export function leaseOverlapsBillingCycle(day: string, observation: LeagueBillingObservation) {
  const start = Date.parse(day + 'T00:00:00Z');
  return (
    start < Date.parse(observation.cycleEnd) &&
    start + 86400000 > Date.parse(observation.cycleStart)
  );
}

/** Trusted deployment configuration; not a proof of storage or CPU allowance. */
export function requireLeagueBillingObservation(
  input: unknown,
  day: string,
  workerRequests = 0,
  deadlineMs = 0,
) {
  const parsed = LeagueBillingObservationSchema.safeParse(input);
  if (!parsed.success) throw new OperationError('USAGE_UNVERIFIED', 'Billing observation required');
  const observation = parsed.data;
  if (
    workerRequests > 0 &&
    (observation.workerDay !== day ||
      observation.workerRemaining === null ||
      observation.workerRemaining < workerRequests + 1000)
  )
    throw new OperationError('USAGE_UNVERIFIED', 'Worker allowance is unknown or insufficient');
  const now = Date.now(),
    observed = Date.parse(observation.observedAt);
  const start = Date.parse(observation.cycleStart),
    end = Date.parse(observation.cycleEnd);
  const dayEnd = Date.parse(day + 'T00:00:00Z') + 86400000;
  if (
    day !== new Date(now).toISOString().slice(0, 10) ||
    now < start ||
    now >= end ||
    now + deadlineMs > end ||
    (workerRequests > 0 && now + deadlineMs > dayEnd) ||
    end <= start ||
    end - start > 35 * 86400000 ||
    observed < start ||
    observed >= end ||
    observed > now ||
    now - observed > OBSERVATION_MAX_AGE_MS ||
    (observation.workerDay !== null && observation.workerDay !== day)
  )
    throw new OperationError('USAGE_UNVERIFIED', 'Unknown, stale or mismatched billing cycle');
  return observation;
}

export function reserveLeagueUsage(
  previous: unknown,
  input: LeagueUsageLease,
  observationInput?: unknown,
): LeagueUsage {
  const lease = operationInput(() => LeagueUsageLeaseSchema.parse(input), 'INPUT_INVALID');
  if (new Date(lease.day + 'T00:00:00Z').toISOString().slice(0, 10) !== lease.day)
    throw new OperationError('INPUT_INVALID', 'Invalid ledger date');
  const observation = requireLeagueBillingObservation(observationInput, lease.day);
  const old =
    previous === null
      ? null
      : operationInput(() => LeagueUsageSchema.parse(previous), 'DATA_INVALID');
  if (old?.schemaVersion === 2) {
    const before = old.observation;
    if (
      before.accountId !== observation.accountId ||
      before.bucket !== observation.bucket ||
      Date.parse(observation.observedAt) < Date.parse(before.observedAt) ||
      (before.cycleStart === observation.cycleStart
        ? before.cycleEnd !== observation.cycleEnd ||
          observation.classAUsed < before.classAUsed ||
          observation.classBUsed < before.classBUsed ||
          observation.otherClassAReserve < before.otherClassAReserve ||
          observation.otherClassBReserve < before.otherClassBReserve
        : observation.cycleStart !== before.cycleEnd) ||
      (before.workerDay === lease.day &&
        before.workerRemaining !== null &&
        (observation.workerDay !== before.workerDay ||
          observation.workerRemaining === null ||
          observation.workerRemaining > before.workerRemaining))
    )
      throw new OperationError(
        'USAGE_UNVERIFIED',
        'Billing observation or cycle moved backwards or skipped',
      );
  }
  if (
    old?.leases.some(
      (entry) =>
        entry.day > lease.day || (old.schemaVersion === 1 && entry.day.slice(0, 7) !== old.month),
    )
  )
    throw new OperationError('DATA_INVALID', 'Invalid league usage date history');
  const leases = [...(old?.leases ?? [])];
  if (leases.some((entry) => entry.id === lease.id))
    throw new OperationError('USAGE_CONSUMED', 'League usage lease already consumed');
  if (leases.length >= 256)
    throw new OperationError('BUDGET_EXCEEDED', 'League retained usage history limit');
  leases.push(lease);
  const ids = new Set<string>();
  const total = {
    classA: CONTROL_RESERVE + observation.classAUsed + observation.otherClassAReserve,
    classB: CONTROL_RESERVE + observation.classBUsed + observation.otherClassBReserve,
  };
  let worker = 0;
  for (const entry of leases) {
    const entryStart = Date.parse(entry.day + 'T00:00:00Z');
    if (ids.has(entry.id) || new Date(entryStart).toISOString().slice(0, 10) !== entry.day)
      throw new OperationError('DATA_INVALID', 'Invalid league usage history');
    ids.add(entry.id);
    if (leaseOverlapsBillingCycle(entry.day, observation)) {
      // Include every day overlapping the exact cycle. Observation may already include it.
      total.classA += entry.classA;
      total.classB += entry.classB;
    }
    if (entry.day === lease.day) worker += entry.worker;
  }
  if (
    lease.worker > 0 &&
    (observation.workerDay !== lease.day || observation.workerRemaining === null)
  )
    throw new OperationError('USAGE_UNVERIFIED', 'Worker allowance is unknown');
  if (
    total.classA > LEAGUE_USAGE_LIMITS.classA ||
    total.classB > LEAGUE_USAGE_LIMITS.classB ||
    worker + 1000 > LEAGUE_USAGE_LIMITS.worker ||
    (lease.worker > 0 && worker + 1000 > observation.workerRemaining!)
  )
    throw new OperationError(
      'BUDGET_EXCEEDED',
      'League billing-cycle or daily request budget exhausted',
    );
  const result = CycleLeagueUsageSchema.parse({
    schemaVersion: 2,
    observation,
    sequence: (old?.sequence ?? 0) + 1,
    leases: leases.sort((a, b) => a.id.localeCompare(b.id)),
  });
  if (Buffer.byteLength(canonicalJson(result)) > PUBLICATION_CONTROL_BYTES)
    throw new OperationError('BUDGET_EXCEEDED', 'League usage ledger size limit');
  return result;
}

/** Conditional durable reservation; lost responses never refund usage. */
export async function admitLeagueUsage(
  store: {
    readControl(): Promise<RemoteObject | null>;
    putControl(data: Buffer, etag: string | null): Promise<void>;
  },
  lease: LeagueUsageLease,
  observation?: LeagueBillingObservation,
) {
  const parsedLease = operationInput(() => LeagueUsageLeaseSchema.parse(lease), 'INPUT_INVALID');
  requireLeagueBillingObservation(observation, parsedLease.day, parsedLease.worker); // Before the control GET.
  const before = await store.readControl();
  const previous = before
    ? operationInput(() => JSON.parse(before.data.toString('utf8')) as unknown, 'DATA_INVALID')
    : null;
  const next = reserveLeagueUsage(previous, parsedLease, observation);
  const bytes = Buffer.from(canonicalJson(next));
  try {
    await store.putControl(bytes, before?.etag ?? null);
  } catch {
    // A failed response may still consume the lease; exact read-back alone recovers it.
  }
  const after = await store.readControl().catch(() => {
    throw new OperationError('USAGE_UNVERIFIED', 'League usage reservation not verified');
  });
  if (!after || !after.data.equals(bytes))
    throw new OperationError('USAGE_UNVERIFIED', 'League usage reservation not verified');
  return next;
}
