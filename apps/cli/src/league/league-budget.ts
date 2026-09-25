import {
  LeagueUsageSchema,
  LeagueUsageLeaseSchema,
  canonicalJson,
  type LeagueUsage,
  type LeagueUsageLease,
} from '@fantasy/domain/spatial';
import type { RemoteObject } from '../publication/publication-remote.ts';
import { PUBLICATION_CONTROL_BYTES } from '../publication/publication-files.ts';

// Leave account-wide headroom; these limits cover this automation, not other clients/visitors.
export const LEAGUE_USAGE_LIMITS = { classA: 900000, classB: 9000000, worker: 90000 } as const;
const CONTROL_RESERVE = 10000; // Per month for bounded probes/control failures; not spendable by jobs.

export function reserveLeagueUsage(previous: unknown, input: LeagueUsageLease): LeagueUsage {
  const lease = LeagueUsageLeaseSchema.parse(input);
  if (new Date(lease.day + 'T00:00:00Z').toISOString().slice(0, 10) !== lease.day)
    throw new Error('Invalid ledger date');
  const month = lease.day.slice(0, 7);
  const old = previous === null ? null : LeagueUsageSchema.parse(previous);
  if (old && old.month > month) throw new Error('League usage clock moved backwards');
  if (old?.leases.some((entry) => entry.day.slice(0, 7) !== old.month || entry.day > lease.day))
    throw new Error('Invalid league usage date history');
  const leases = old?.month === month ? [...old.leases] : [];
  if (leases.some((entry) => entry.id === lease.id))
    throw new Error('League usage lease already consumed');
  leases.push(lease);
  const ids = new Set<string>();
  const total = { classA: CONTROL_RESERVE, classB: CONTROL_RESERVE };
  const days = new Map<string, number>();
  for (const entry of leases) {
    if (entry.day.slice(0, 7) !== month || ids.has(entry.id))
      throw new Error('Invalid league usage history');
    ids.add(entry.id);
    total.classA += entry.classA;
    total.classB += entry.classB;
    days.set(entry.day, (days.get(entry.day) ?? 0) + entry.worker);
  }
  if (
    total.classA > LEAGUE_USAGE_LIMITS.classA ||
    total.classB > LEAGUE_USAGE_LIMITS.classB ||
    [...days.values()].some((value) => value + 1000 > LEAGUE_USAGE_LIMITS.worker)
  )
    throw new Error('League monthly or daily request budget exhausted');
  const result = LeagueUsageSchema.parse({
    schemaVersion: 1,
    month,
    sequence: (old?.sequence ?? 0) + 1,
    leases: leases.sort((a, b) => a.id.localeCompare(b.id)),
  });
  if (Buffer.byteLength(canonicalJson(result)) > PUBLICATION_CONTROL_BYTES)
    throw new Error('League usage ledger size limit');
  return result;
}

/** Conditional durable reservation before data access; lost responses never refund usage. */
export async function admitLeagueUsage(
  store: {
    readControl(): Promise<RemoteObject | null>;
    putControl(data: Buffer, etag: string | null): Promise<void>;
  },
  lease: LeagueUsageLease,
) {
  const before = await store.readControl();
  const next = reserveLeagueUsage(before ? JSON.parse(before.data.toString('utf8')) : null, lease);
  const bytes = Buffer.from(canonicalJson(next));
  let uncertain: unknown;
  try {
    await store.putControl(bytes, before?.etag ?? null);
  } catch (error) {
    uncertain = error;
  }
  const after = await store.readControl();
  if (!after || !after.data.equals(bytes))
    throw uncertain ?? new Error('League usage reservation not verified');
  return next;
}
