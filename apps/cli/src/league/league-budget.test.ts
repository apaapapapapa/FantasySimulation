import { afterEach, expect, it, vi } from 'vite-plus/test';
import { PublicKeySchema, type LeagueUsageLease } from '@fantasy/domain/spatial';
import { reserveLeagueUsage as reserve, admitLeagueUsage as admit } from './league-budget.ts';
import { billingObservation } from '../../test-support/league-billing.ts';
import { PUBLICATION_CONTROL_KEY } from '../publication/publication-files.ts';
import { leagueTransferBudget } from './league-transfer.ts';

afterEach(() => vi.restoreAllMocks());
const observe = (input: LeagueUsageLease) => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(input.day + 'T12:00:00Z'));
  return billingObservation(input.day);
};
const reserveLeagueUsage = (previous: unknown, input: LeagueUsageLease) =>
  reserve(previous, input, observe(input));
const admitLeagueUsage = (store: Parameters<typeof admit>[0], input: LeagueUsageLease) =>
  admit(store, input, observe(input));

const lease = (id: string, values: Partial<LeagueUsageLease> = {}): LeagueUsageLease => ({
  id,
  sourceSha: 'a'.repeat(40),
  day: '2026-09-25',
  classA: 445000,
  classB: 1000000,
  worker: 1000,
  ...values,
});
it('retains consumed budgets across calendar months within the same billing cycle', () => {
  const first = reserveLeagueUsage(null, lease('run-1'));
  const second = reserveLeagueUsage(first, lease('run-2', { day: '2026-09-26' }));
  expect(second.leases.map((entry) => entry.id)).toEqual(['run-1', 'run-2']);
  expect(() =>
    reserveLeagueUsage(second, lease('run-3', { day: '2026-09-27', classA: 1 })),
  ).toThrow('budget exhausted');
  expect(() => reserveLeagueUsage(second, lease('run-2', { day: '2026-09-26' }))).toThrow(
    'already consumed',
  );
  expect(() => reserveLeagueUsage(second, lease('run-3'))).toThrow('backwards');
  expect(() => reserveLeagueUsage(second, lease('run-3', { day: '2026-10-01' }))).toThrow(
    'budget exhausted',
  );
  expect(second.leases).toHaveLength(2);
});
it('bounds monthly reads, per-day worker requests and calendar dates', () => {
  const first = reserveLeagueUsage(
    null,
    lease('run-1', { classA: 0, classB: 8990000, worker: 89000 }),
  );
  expect(() =>
    reserveLeagueUsage(first, lease('run-2', { classA: 0, classB: 1, worker: 0 })),
  ).toThrow('budget exhausted');
  expect(() =>
    reserveLeagueUsage(first, lease('run-2', { classA: 0, classB: 0, worker: 1 })),
  ).toThrow('budget exhausted');
  expect(
    reserveLeagueUsage(
      first,
      lease('run-2', { day: '2026-09-26', classA: 0, classB: 0, worker: 1 }),
    ).leases,
  ).toHaveLength(2);
  expect(() => reserveLeagueUsage(null, lease('invalid', { day: '2026-02-31' }))).toThrow('date');
  expect(PublicKeySchema.safeParse(PUBLICATION_CONTROL_KEY).success).toBe(false);
});

function storage() {
  let current: { data: Buffer; etag: string } | null = null;
  let version = 0;
  return {
    readControl: async () => current,
    putControl: async (data: Buffer, etag: string | null) => {
      if ((current?.etag ?? null) !== etag) throw new Error('conditional conflict');
      current = { data, etag: String(++version) };
    },
  };
}
it.each(['{', '{}'])('rejects malformed saved usage data before any write (%s)', async (data) => {
  const putControl = vi.fn();
  await expect(
    admitLeagueUsage(
      { readControl: async () => ({ data: Buffer.from(data), etag: 'old' }), putControl },
      lease('next-run'),
    ),
  ).rejects.toMatchObject({ code: 'DATA_INVALID' });
  expect(putControl).not.toHaveBeenCalled();
});
it('verifies a durable lease after a lost response, and never refunds a crashed execution', async () => {
  const store = storage(),
    put = store.putControl;
  store.putControl = async (...args) => {
    await put(...args);
    throw new Error('response lost');
  };
  expect((await admitLeagueUsage(store, lease('crashed-run'))).leases).toHaveLength(1);
  await expect(admitLeagueUsage(store, lease('crashed-run'))).rejects.toThrow('already consumed');
  expect((await admitLeagueUsage(store, lease('next-run'))).leases).toHaveLength(2);
  await expect(admitLeagueUsage(store, lease('too-many'))).rejects.toThrow('budget exhausted');
});
it('does not admit unverified writes or concurrent leases based on the same generation', async () => {
  await expect(
    admitLeagueUsage(
      { readControl: async () => null, putControl: async () => {} },
      lease('missing'),
    ),
  ).rejects.toThrow('not verified');
  const store = storage();
  const results = await Promise.allSettled([
    admitLeagueUsage(store, lease('one')),
    admitLeagueUsage(store, lease('two')),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(JSON.parse((await store.readControl())!.data.toString()).leases).toHaveLength(1);
});
it('reserves collision OR recovery reads, pointer barriers and retries without removed HEADs', () => {
  // Restore: every file plus pointer/catalog/current reads and 1,024 counted transient retries.
  expect(leagueTransferBudget(926, 60, 0, true)).toEqual({ classA: 1, classB: 1953, worker: 0 });
  const full = leagueTransferBudget(335183, 7600, 335183, false);
  expect(full.classA).toBe(335183 + 502 + 256);
  expect(full.classB).toBe(7600 + 335183 + 10 + 1024);
  expect(full.classB).toBeGreaterThan(335183 + 7600);
  expect(full.worker).toBe(1000);
  const reserved = reserveLeagueUsage(
    null,
    lease('official', { ...full, classB: full.classB + full.worker }),
  );
  expect(reserved.leases).toHaveLength(1);
  for (const invalid of [-1, 500001, 1.5, NaN])
    expect(() => leagueTransferBudget(invalid, 0, 0, true)).toThrow('counts');
});
it('applies smaller reservations only to new leases without refunding earlier usage', () => {
  const consumed = lease('old-publication', { classA: 1000, classB: 5000, worker: 0 });
  const before = reserveLeagueUsage(null, consumed);
  const next = leagueTransferBudget(100, 20, 50, false);
  const after = reserveLeagueUsage(
    before,
    lease('new-publication', { ...next, classB: next.classB + next.worker }),
  );
  expect(after.leases).toHaveLength(2);
  expect(after.leases.find((entry) => entry.id === consumed.id)).toEqual(consumed);
  expect(before.leases).toEqual([consumed]);
  expect(after.leases.find((entry) => entry.id === 'new-publication')?.classB).toBe(
    100 + 20 + 10 + 1024 + 1000,
  );
});
