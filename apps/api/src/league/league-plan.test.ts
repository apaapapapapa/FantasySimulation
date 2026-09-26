import { expect, it } from 'vite-plus/test';
import { contentHash } from '@fantasy/domain/spatial';
import { leagueInput, leagueEstimate } from '../../test-support/leagues.ts';
import { batchSource } from '../../test-support/batches.ts';
import {
  estimateLeague,
  planLeague,
  validateLeaguePlan,
  validateLeaguePartition,
} from './league-plan.ts';
import { leagueFixture } from '@fantasy/samples/testing';

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
    { retainedFiles: 499999 },
    { maxReadRequests: 1 },
    { maxWriteRequests: 1 },
    { estimatedMsPerMatch: 1800000 },
  ])
    await expect(
      planLeague(input, batchSource, { ...leagueEstimate, ...overrides }),
    ).rejects.toThrow(/budget|bounded/);
});

it('admits the measured 7600-slot profile but still rejects retained-file and monthly ceilings', async () => {
  const definition = await leagueFixture(20, 5);
  definition.trials = 4;
  const profile = {
    ...leagueEstimate,
    estimatedMsPerMatch: 4000,
    estimatedBytesPerMatch: 600000,
    estimatedFilesPerMatch: 44,
    maxWriteRequests: 900000,
    maxReadRequests: 9000000,
  };
  const counts = { reused: 0, retries: 0, exhausted: 0 };
  expect(estimateLeague(definition, profile, counts)).toMatchObject({
    planned: 7600,
    partitions: 60,
    matchesPerPlan: 128,
    estimatedBytes: 6000000000,
    estimatedFiles: 335183,
  });
  for (const extra of [
    { retainedFiles: 164818 },
    { usedWriteRequests: 564818 },
    { usedReadRequests: 9000000 },
  ])
    expect(() => estimateLeague(definition, { ...profile, ...extra }, counts)).toThrow('budget');
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
