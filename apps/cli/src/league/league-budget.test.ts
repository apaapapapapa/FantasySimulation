import { expect, it, vi } from 'vite-plus/test';
import { PublicKeySchema, type LeagueUsageLease } from '@fantasy/domain/spatial';
import { reserveLeagueUsage, admitLeagueUsage } from './league-budget.ts';
import { PUBLICATION_CONTROL_KEY } from '../publication/publication-files.ts';
import { leagueTransferBudget } from './league-transfer.ts';

const lease = (id: string, values: Partial<LeagueUsageLease> = {}): LeagueUsageLease => ({
  id,
  sourceSha: 'a'.repeat(40),
  day: '2026-09-25',
  classA: 445000,
  classB: 1000000,
  worker: 1000,
  ...values,
});
it('retains consumed budgets across runs/days, rejects exhaustion and resets only in a later month', () => {
  const first = reserveLeagueUsage(null, lease('run-1'));
  const second = reserveLeagueUsage(first, lease('run-2', { day: '2026-09-26' }));
  expect(second.leases.map((entry) => entry.id)).toEqual(['run-1', 'run-2']);
  expect(() =>
    reserveLeagueUsage(second, lease('run-3', { day: '2026-09-27', classA: 1 })),
  ).toThrow('budget exhausted');
  expect(() => reserveLeagueUsage(second, lease('run-2', { day: '2026-09-26' }))).toThrow(
    'already consumed',
  );
  expect(() => reserveLeagueUsage(second, lease('run-3'))).toThrow('date history');
  const next = reserveLeagueUsage(second, lease('run-3', { day: '2026-10-01' }));
  expect(next).toMatchObject({ month: '2026-10', sequence: 3 });
  expect(next.leases).toHaveLength(1);
  expect(() => reserveLeagueUsage(next, lease('run-4'))).toThrow('backwards');
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
it('reserves restoration, immutable collision/head/recovery reads and publication before admission', () => {
  expect(leagueTransferBudget(926, 60, 0, true)).toEqual({ classA: 1, classB: 929, worker: 0 });
  const full = leagueTransferBudget(335183, 7600, 335183, false);
  expect(full.classA).toBeGreaterThan(335183);
  expect(full.classB).toBeGreaterThan(335183 * 2 + 7600);
  expect(full.worker).toBe(1000);
  const reserved = reserveLeagueUsage(
    null,
    lease('official', { ...full, classB: full.classB + full.worker }),
  );
  expect(reserved.leases).toHaveLength(1);
  for (const invalid of [-1, 500001, 1.5, NaN])
    expect(() => leagueTransferBudget(invalid, 0, 0, true)).toThrow('counts');
});
