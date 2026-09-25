import { expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { contentHash, canonicalJson } from '@fantasy/domain/spatial';
import { leagueInput, leagueEstimate } from '../../test-support/leagues.ts';
import { batchSource } from '../../test-support/batches.ts';
import { withReplayDirectory } from '../../test-support/replays.ts';
import { planLeague, validateLeaguePlan, validateLeaguePartition } from './league-plan.ts';
import { nextLeagueAttempt } from './league-progress.ts';
import { reserveLeaguePartition, runLeaguePartition } from './league-runner.ts';
import { BattleBundles } from '../batch/battle-bundle.ts';
import { checkLeague } from './league-check.ts';

it('partitions more than 1000 fixed slots into bounded plans and authenticates each range', async () => {
  const result = await planLeague(await leagueInput(24), batchSource, leagueEstimate);
  expect(result.estimate.planned).toBe(1104);
  expect(result.partitions.map((p) => p.batch.slots.length)).toEqual([
    128, 128, 128, 128, 128, 128, 128, 128, 80,
  ]);
  expect(await validateLeaguePlan(result.plan)).toEqual(result.plan);
  for (const entry of [result.partitions[0]!, result.partitions.at(-1)!])
    await expect(
      validateLeaguePartition(result.plan, entry.partition, entry.batch),
    ).resolves.toEqual(entry);
  expect(new Set(result.partitions.flatMap((p) => p.partition.slots.map((s) => s.id))).size).toBe(
    1104,
  );
  const altered = structuredClone(result.partitions[0]!);
  altered.partition.slots[0]!.seed++;
  const { id: _, ...body } = altered.partition;
  altered.partition.id = await contentHash(body);
  await expect(
    validateLeaguePartition(result.plan, altered.partition, altered.batch),
  ).rejects.toThrow(/identity/);
}, 30000);

it('rejects dry-run estimates above storage, file, request and execution capacity before running', async () => {
  const input = await leagueInput();
  for (const overrides of [
    { retainedBytes: 7999999999 },
    { retainedFiles: 99999 },
    { maxReadRequests: 1 },
    { maxWriteRequests: 1 },
    { estimatedMsPerMatch: 1800000 },
  ])
    await expect(
      planLeague(input, batchSource, { ...leagueEstimate, ...overrides }),
    ).rejects.toThrow(/budget|bounded/);
});

it('persists at most one extra attempt across daily reservations, including killed jobs', async () => {
  const { plan, partitions } = await planLeague(await leagueInput(), batchSource, leagueEstimate),
    { partition } = partitions[0]!;
  const first = await reserveLeaguePartition(plan, partition, [], 'day-1');
  expect(first.progress.records.map(nextLeagueAttempt)).toEqual([2, 2, 2, 2]);
  await expect(
    reserveLeaguePartition(plan, partition, first.progress.records, 'day-1'),
  ).rejects.toThrow(/already reserved/);
  const second = await reserveLeaguePartition(plan, partition, first.progress.records, 'day-2');
  const third = await reserveLeaguePartition(plan, partition, second.progress.records, 'day-3');
  expect(third.progress).toEqual(second.progress);
  expect(third.progress.records.map(nextLeagueAttempt)).toEqual([null, null, null, null]);
});

it('reduces partition sizes to fit the existing work-byte reserve', async () => {
  const profile = { ...leagueEstimate, estimatedBytesPerMatch: 5 * 1024 ** 2 };
  const prepared = await planLeague(await leagueInput(12), batchSource, profile);
  expect(prepared.partitions.map((p) => p.batch.slots.length)).toEqual([94, 94, 76]);
  for (const { batch } of prepared.partitions)
    expect(
      batch.slots.length * profile.estimatedBytesPerMatch + 40 * 1024 ** 2,
    ).toBeLessThanOrEqual(batch.maxWorkBytes);
}, 30000);

it('budgets verified retained partial bytes in addition to the next attempt', async () => {
  await withReplayDirectory(async (root) => {
    const input = await leagueInput();
    input.trials = 12;
    input.budget.maxEvents = 1;
    const profile = { ...leagueEstimate, estimatedBytesPerMatch: 20 * 1024 ** 2 };
    const first = await planLeague(input, batchSource, profile);
    const { partition, batch } = first.partitions[0]!;
    expect(batch.slots).toHaveLength(23);
    const reservation = await reserveLeaguePartition(first.plan, partition, [], 'small-output');
    const output = join(root, 'run');
    const result = await runLeaguePartition(
      first.plan,
      partition,
      batch,
      reservation,
      output,
      batchSource,
      'small-output',
    );
    const bundles = new BattleBundles(join(output, 'bundles'));
    const next = await planLeague(input, batchSource, profile, result.progress.records, bundles);
    const receiptBytes = result.index.slots.reduce(
      (sum, s) => sum + s.receipt!.bytes + Buffer.byteLength(canonicalJson(s.receipt)) + 100,
      0,
    );
    expect(next.partitions[0]!.batch.maxOutputBytes - batch.maxOutputBytes).toBe(receiptBytes);
    expect(next.estimate.estimatedBytes - first.estimate.estimatedBytes).toBe(receiptBytes);
  });
}, 30000);

it('leaves never-admitted slots pending and uses the same slots on resumption', async () => {
  await withReplayDirectory(async (root) => {
    const { plan, partitions } = await planLeague(await leagueInput(), batchSource, leagueEstimate),
      { partition, batch } = partitions[0]!;
    const first = await reserveLeaguePartition(plan, partition, [], 'run-1');
    const stopped = await runLeaguePartition(
      plan,
      partition,
      batch,
      first,
      join(root, 'run1'),
      batchSource,
      'run-1',
      { deadlineMs: 1 },
    );
    expect(stopped.index.slots.every((s) => s.state === 'pending')).toBe(true);
    expect(stopped.progress.records.every((r) => r.attempts.length === 0)).toBe(true);
    await expect(
      runLeaguePartition(plan, partition, batch, first, join(root, 'run1'), batchSource, 'run-1'),
    ).rejects.toThrow(/EEXIST/);
    const next = await reserveLeaguePartition(plan, partition, stopped.progress.records, 'run-2');
    const complete = await runLeaguePartition(
      plan,
      partition,
      batch,
      next,
      join(root, 'run2'),
      batchSource,
      'run-2',
    );
    expect(complete.index.complete).toBe(true);
    const missing = await checkLeague(plan, []);
    expect(missing.standings).toMatchObject({ status: 'provisional', planned: 4, resolved: 0 });
    const checked = await checkLeague(plan, [
      {
        partition,
        batch,
        reservation: next,
        result: complete,
        bundles: new BattleBundles(join(root, 'run2', 'bundles')),
      },
    ]);
    expect(checked.standings).toMatchObject({ status: 'formal', planned: 4, resolved: 4 });
    await expect(
      checkLeague(plan, [
        {
          partition,
          batch,
          reservation: first,
          result: complete,
          bundles: new BattleBundles(join(root, 'run2', 'bundles')),
        },
      ]),
    ).rejects.toThrow(/reservation/);
    expect(complete.index.slots.map((s) => s.slotId)).toEqual(
      stopped.index.slots.map((s) => s.slotId),
    );
  });
}, 30000);

it('retries truncated outcomes with the increased budget and then reuses only verified definitive bytes', async () => {
  await withReplayDirectory(async (root) => {
    const input = await leagueInput();
    input.budget.maxEvents = 1;
    const { plan, partitions } = await planLeague(input, batchSource, leagueEstimate),
      { partition, batch } = partitions[0]!;
    const first = await reserveLeaguePartition(plan, partition, [], 'small');
    const limited = await runLeaguePartition(
      plan,
      partition,
      batch,
      first,
      join(root, 'small'),
      batchSource,
      'small',
    );
    expect(limited.index.slots.every((s) => s.state === 'truncated')).toBe(true);
    const prior = new BattleBundles(join(root, 'small', 'bundles'));
    const second = await reserveLeaguePartition(
      plan,
      partition,
      limited.progress.records,
      'larger',
      prior,
    );
    const paused = await runLeaguePartition(
      plan,
      partition,
      batch,
      second,
      join(root, 'paused'),
      batchSource,
      'larger',
      { retained: prior, deadlineMs: 1 },
    );
    expect(paused.progress).toEqual(limited.progress);
    expect(paused.index.slots.every((s) => s.state === 'truncated')).toBe(true);
    expect(
      (
        await checkLeague(plan, [
          {
            partition,
            batch,
            reservation: second,
            result: paused,
            bundles: new BattleBundles(join(root, 'paused', 'bundles')),
          },
        ])
      ).standings.resolved,
    ).toBe(0);
    const complete = await runLeaguePartition(
      plan,
      partition,
      batch,
      second,
      join(root, 'larger'),
      batchSource,
      'larger',
      { retained: prior },
    );
    expect(complete.index.complete).toBe(true);
    expect(
      complete.progress.records.every(
        (r) => r.attempts.length === 2 && r.attempts[1]!.state === 'draw',
      ),
    ).toBe(true);
    const retained = new BattleBundles(join(root, 'larger', 'bundles'));
    // The retry preserves its first partial receipt, without adding it to the definitive cache.
    for (const record of complete.progress.records) {
      expect(record.attempts[0]!.state).toBe('truncated');
      expect((await retained.verify(record.attempts[0]!.objectHash!)).result.outcome.kind).toBe(
        'truncated',
      );
    }
    const again = await planLeague(
      input,
      batchSource,
      leagueEstimate,
      complete.progress.records,
      retained,
    );
    expect(again.estimate).toMatchObject({ reused: 4, compute: 0 });
    const reservation = await reserveLeaguePartition(
      plan,
      partition,
      complete.progress.records,
      'reuse',
      retained,
    );
    const reused = await runLeaguePartition(
      plan,
      partition,
      batch,
      reservation,
      join(root, 'reuse'),
      batchSource,
      'reuse',
      { retained },
    );
    expect(reused.index.slots.every((s) => s.reused)).toBe(true);
    const receipt = reused.index.slots[0]!.receipt!,
      file = join(
        root,
        'reuse',
        'bundles',
        'objects',
        receipt.objectHash.slice(7),
        'manifest.json',
      );
    const original = await readFile(file);
    await writeFile(file, Buffer.concat([original, Buffer.from(' ')]));
    await expect(
      new BattleBundles(join(root, 'bad')).importConfirmed(
        new BattleBundles(join(root, 'reuse', 'bundles')),
        receipt.objectHash,
      ),
    ).rejects.toThrow(/checksum/);
  });
}, 30000);
