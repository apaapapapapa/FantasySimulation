import { afterEach, expect, it, vi } from 'vite-plus/test';
import { LeagueUsageSchema, type LeagueUsageLease } from '@fantasy/domain/spatial';
import {
  reserveLeagueUsage,
  admitLeagueUsage,
  requireLeagueBillingObservation,
} from './league-budget.ts';
import { billingObservation } from '../../test-support/league-billing.ts';
import { transferCloudLeague } from './league-transfer.ts';
import { openLeagueStaging } from './league-staging.ts';
import { PublicationS3 } from '../publication/publication-s3.ts';

afterEach(() => vi.restoreAllMocks());
const lease = (id: string, day = '2026-09-30', classA = 1): LeagueUsageLease => ({
  id,
  day,
  classA,
  classB: 0,
  worker: 0,
  sourceSha: 'a'.repeat(40),
});
function observation(day = '2026-09-30') {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(day + 'T12:00:00Z'));
  return billingObservation(day);
}
it('migrates legacy leases exactly and does not revive exhausted allowance at October1', () => {
  const old = {
    schemaVersion: 1,
    month: '2026-09',
    sequence: 4,
    leases: [lease('old', '2026-09-30', 889999)],
  };
  expect(LeagueUsageSchema.parse(old)).toEqual(old);
  const next = reserveLeagueUsage(old, lease('new'), observation());
  expect(next.sequence).toBe(5);
  expect(next.leases.find((entry) => entry.id === 'old')).toEqual(old.leases[0]);
  expect(next.schemaVersion).toBe(2);
  expect(() =>
    reserveLeagueUsage(next, lease('october', '2026-10-01'), observation('2026-10-01')),
  ).toThrow('budget exhausted');
  expect(old.leases).toEqual([lease('old', '2026-09-30', 889999)]);
});
it('updates only to the adjacent exact cycle while retaining history and duplicate IDs', () => {
  const first = reserveLeagueUsage(null, lease('old', '2026-09-30', 889999), observation());
  const input = {
    ...observation('2026-10-12'),
    cycleStart: '2026-10-12T00:00:00Z',
    cycleEnd: '2026-11-12T00:00:00Z',
  };
  const next = reserveLeagueUsage(first, lease('new', '2026-10-12', 889999), input);
  expect(next.leases).toEqual([
    lease('new', '2026-10-12', 889999),
    lease('old', '2026-09-30', 889999),
  ]);
  expect(next.sequence).toBe(2);
  expect(() => reserveLeagueUsage(next, lease('old', '2026-10-12'), input)).toThrow(
    'already consumed',
  );
  expect(() =>
    reserveLeagueUsage(first, lease('gap', '2026-10-12'), {
      ...input,
      cycleStart: '2026-10-11T00:00:00Z',
    }),
  ).toThrow('skipped');
});
it.each([
  'missing',
  'future',
  'stale',
  'unknown-boundary',
  'expired',
  'too-long',
  'wrong-worker-day',
])('rejects %s observations before any control I/O', async (kind) => {
  const input = observation();
  let value: unknown = input;
  if (kind === 'missing') value = undefined;
  if (kind === 'future') input.observedAt = '2026-09-30T12:00:01Z';
  if (kind === 'stale') input.observedAt = '2026-09-30T10:59:59Z';
  if (kind === 'unknown-boundary') input.cycleStart = '2026-09-12';
  if (kind === 'expired') input.cycleEnd = '2026-09-30T12:00:00Z';
  if (kind === 'too-long') input.cycleEnd = '2026-11-12T00:00:00Z';
  if (kind === 'wrong-worker-day') input.workerDay = '2026-09-29';
  const store = { readControl: vi.fn(), putControl: vi.fn() };
  await expect(admitLeagueUsage(store, lease('new'), value as typeof input)).rejects.toMatchObject({
    code: 'USAGE_UNVERIFIED',
  });
  expect(store.readControl).not.toHaveBeenCalled();
  expect(store.putControl).not.toHaveBeenCalled();
});
it.each([
  'classA',
  'classB',
  'reserve',
  'worker-increase',
  'worker-unknown',
  'older-time',
  'account',
  'bucket',
])('does not restore allowance using a %s observation change', (kind) => {
  const input = {
    ...observation(),
    classAUsed: 10,
    classBUsed: 10,
    otherClassAReserve: 10,
    workerRemaining: 4000,
  };
  const first = reserveLeagueUsage(null, lease('old'), input);
  const next = { ...input };
  if (kind === 'classA') next.classAUsed = 9;
  if (kind === 'classB') next.classBUsed = 9;
  if (kind === 'reserve') next.otherClassAReserve = 9;
  if (kind === 'worker-increase') next.workerRemaining = 4001;
  if (kind === 'worker-unknown') Object.assign(next, { workerRemaining: null, workerDay: null });
  if (kind === 'older-time') next.observedAt = '2026-09-30T11:59:59Z';
  if (kind === 'account') next.accountId = 'b'.repeat(32);
  if (kind === 'bucket') next.bucket = 'other-bucket';
  expect(() => reserveLeagueUsage(first, lease('new'), next)).toThrow('backwards');
});
it('rejects unknown Worker allowance before control reads but permits a Worker-free reservation', async () => {
  const input = { ...observation(), workerDay: null, workerRemaining: null };
  expect(() => reserveLeagueUsage(null, { ...lease('worker'), worker: 1 }, input)).toThrow(
    'unknown',
  );
  expect(reserveLeagueUsage(null, lease('readback'), input).leases).toHaveLength(1);
  const store = { readControl: vi.fn(), putControl: vi.fn() };
  await expect(
    admitLeagueUsage(store, { ...lease('worker'), worker: 1 }, input),
  ).rejects.toMatchObject({ code: 'USAGE_UNVERIFIED' });
  expect(store.readControl).not.toHaveBeenCalled();
  expect(store.putControl).not.toHaveBeenCalled();
});
it('counts observations, other workloads and all unreleased reservations conservatively', () => {
  const input = { ...observation(), classAUsed: 183470, otherClassAReserve: 50000 };
  expect(() => reserveLeagueUsage(null, lease('over', '2026-09-30', 656531), input)).toThrow(
    'budget exhausted',
  );
  const first = reserveLeagueUsage(null, lease('bound', '2026-09-30', 656530), input);
  expect(() => reserveLeagueUsage(first, lease('release', '2026-09-30', -1), input)).toThrow();
  expect(() => reserveLeagueUsage(first, lease('bound'), input)).toThrow('already consumed');
});
it('includes a boundary-day lease conservatively for non-midnight billing periods', () => {
  const old = {
    schemaVersion: 1,
    month: '2026-09',
    sequence: 1,
    leases: [lease('old', '2026-09-12', 890000)],
  };
  const input = { ...observation(), cycleStart: '2026-09-12T04:00:00Z' };
  expect(() => reserveLeagueUsage(old, lease('new'), input)).toThrow('budget exhausted');
});
it('refuses transport budgets crossing the billing boundary or Worker UTC day', () => {
  const input = observation();
  expect(() =>
    requireLeagueBillingObservation(
      { ...input, cycleEnd: '2026-09-30T12:59:59Z' },
      '2026-09-30',
      0,
      3600000,
    ),
  ).toThrow('billing cycle');
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-30T23:30:00Z'));
  expect(() =>
    requireLeagueBillingObservation(
      { ...input, observedAt: '2026-09-30T23:30:00Z' },
      '2026-09-30',
      1000,
      3600000,
    ),
  ).toThrow('billing cycle');
});
it('does not discard any history at the retained256-lease bound', () => {
  const leases = Array.from({ length: 256 }, (_, i) => lease('old-' + i, '2026-09-30', 0));
  const old = { schemaVersion: 1, month: '2026-09', sequence: 256, leases };
  expect(() => reserveLeagueUsage(old, lease('new'), observation())).toThrow();
  expect(old.leases).toHaveLength(256);
});
it('rejects unknown or mismatched billing config before production transport reads', async () => {
  const read = vi.spyOn(PublicationS3.prototype, 'readControl');
  const inventory = vi.spyOn(PublicationS3.prototype, 'inventory');
  const config = {
    accountId: 'a'.repeat(32),
    bucket: 'fixture-bucket',
    accessKeyId: 'fixture',
    secretAccessKey: 'fixture',
  };
  const identity = lease('blocked');
  await expect(openLeagueStaging(config, identity)).rejects.toMatchObject({
    code: 'USAGE_UNVERIFIED',
  });
  await expect(transferCloudLeague(config, '.', '.', identity)).rejects.toMatchObject({
    code: 'USAGE_UNVERIFIED',
  });
  await expect(
    openLeagueStaging(
      { ...config, billingObservation: { ...observation(), accountId: 'b'.repeat(32) } },
      identity,
    ),
  ).rejects.toMatchObject({ code: 'USAGE_UNVERIFIED' });
  expect(read).not.toHaveBeenCalled();
  expect(inventory).not.toHaveBeenCalled();
});
