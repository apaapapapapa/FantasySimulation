import { expect, it } from 'vite-plus/test';
import { contentHash } from '@fantasy/domain/spatial';
import { join } from 'node:path';
import { leagueInput, leagueEstimate } from '../../test-support/leagues.ts';
import { batchSource } from '../../test-support/batches.ts';
import { planLeague } from './league-plan.ts';
import {
  storedLeagueInputs,
  storedResultPartition,
  storedLeagueBundleBinding,
} from './league-stored.ts';
import { checkLeague, checkStoredLeague } from './league-check.ts';
import { BattleBundles } from '../batch/battle-bundle.ts';
import { withReplayDirectory } from '../../test-support/replays.ts';
import { reserveLeaguePartition, runLeaguePartition } from './league-runner.ts';

it('authenticates every original partition, including missing results, independently of input order', async () => {
  const fixture = await planLeague(await leagueInput(), batchSource, {
    ...leagueEstimate,
    matchesPerPlan: 2,
  });
  const saved = await checkStoredLeague(fixture.plan, fixture.partitions.toReversed(), []);
  expect(saved.standings).toEqual((await checkLeague(fixture.plan, [])).standings);
  expect(saved.missingPartitions).toEqual([0, 1]);
  for (const inputs of [
    fixture.partitions.slice(1),
    [fixture.partitions[0]!, fixture.partitions[0]!],
  ])
    await expect(storedLeagueInputs(fixture.plan, inputs)).rejects.toThrow(/Missing|Duplicate/);
  const changed = structuredClone(fixture.partitions[0]!);
  changed.batch.slots[0]!.spec.seed++;
  expect(() => storedResultPartition(saved, changed)).toThrow('differs from stored');
});

it.each(['coordinate', 'spec', 'digest', 'source', 'revision'] as const)(
  'rejects a resealed stored partition with a mismatched %s',
  async (fault) => {
    const fixture = await planLeague(await leagueInput(), batchSource, leagueEstimate),
      entry = fixture.partitions[0]!;
    if (fault === 'coordinate') entry.partition.slots[0]!.seed++;
    if (fault === 'spec') entry.batch.slots[0]!.spec.seed++;
    if (fault === 'digest') entry.batch.implementationDigest = 'sha256:' + 'f'.repeat(64);
    if (fault === 'source') entry.batch.source.sha = 'e'.repeat(40);
    if (fault === 'revision') entry.batch.revisions.pop();
    const { id: _batch, ...batchBody } = entry.batch;
    entry.batch.id = await contentHash(batchBody);
    entry.partition.batchPlanId = entry.batch.id;
    const { id: _partition, ...partitionBody } = entry.partition;
    entry.partition.id = await contentHash(partitionBody);
    fixture.plan.partitions[0] = {
      partitionId: entry.partition.id,
      batchPlanId: entry.batch.id,
      slots: entry.partition.slots.length,
    };
    const { id: _plan, ...planBody } = fixture.plan;
    fixture.plan.id = await contentHash(planBody);
    await expect(storedLeagueInputs(fixture.plan, fixture.partitions)).rejects.toThrow(/mismatch/);
  },
);

it('binds verified recorded inputs to saved participant, engine and definition identities', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await planLeague(await leagueInput(), batchSource, leagueEstimate),
      { partition, batch } = fixture.partitions[0]!;
    const reservation = await reserveLeaguePartition(
      fixture.plan,
      partition,
      [],
      'recorded-binding',
    );
    const result = await runLeaguePartition(
      fixture.plan,
      partition,
      batch,
      reservation,
      root,
      batchSource,
      'recorded-binding',
    );
    const bundles = new BattleBundles(join(root, 'bundles')),
      receipt = await bundles.verify(result.index.slots[0]!.receipt!.objectHash),
      slot = batch.slots.find((slot) => slot.simulationHash === receipt.simulationHash)!;
    await expect(storedLeagueBundleBinding(batch, bundles)(slot, receipt)).resolves.toBeUndefined();
    for (const fault of ['spec', 'engine', 'revision'] as const) {
      const changed = structuredClone(batch),
        altered = structuredClone(slot);
      if (fault === 'spec') altered.spec.seed++;
      if (fault === 'engine') changed.implementationDigest = 'sha256:' + 'f'.repeat(64);
      if (fault === 'revision') changed.revisions = [];
      await expect(storedLeagueBundleBinding(changed, bundles)(altered, receipt)).rejects.toThrow(
        'recording and plan mismatch',
      );
    }
  });
}, 30000);
