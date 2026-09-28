import { expect, it, vi } from 'vite-plus/test';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { LeagueProgress } from '@fantasy/domain/spatial';
import { leagueInput, leagueEstimate, privateLeagueInput } from '../../test-support/leagues.ts';
import { batchSource } from '../../test-support/batches.ts';
import { flipFirstByte, withReplayDirectory } from '../../test-support/replays.ts';
import { BattleBundles } from '../batch/battle-bundle.ts';
import { runBatch } from '../batch/batch-runner.ts';
import { BattlePool } from '../jobs/worker-pool.ts';
import { Measurements } from '../measurements.ts';
import { planLeague } from './league-plan.ts';
import { reserveLeaguePartition, runLeaguePartition } from './league-runner.ts';

/** A truncating first execution and its completed retry, retaining every attempt's replay. */
async function retainedLeague(root: string) {
  const input = await leagueInput();
  input.budget.maxEvents = 1;
  const { plan, partitions } = await planLeague(input, batchSource, leagueEstimate);
  const { partition, batch } = partitions[0]!;
  const reserve = (id: string, records: readonly LeagueProgress[], retained?: BattleBundles) =>
    reserveLeaguePartition(plan, partition, records, id, retained);
  const run = (id: string, reservation: unknown, options: { retained?: BattleBundles } = {}) =>
    runLeaguePartition(
      plan,
      partition,
      batch,
      reservation,
      join(root, id),
      batchSource,
      id,
      options,
    );
  const first = await run('first', await reserve('first', []));
  const prior = new BattleBundles(join(root, 'first', 'bundles'));
  const retry = await run('retry', await reserve('retry', first.progress.records, prior), {
    retained: prior,
  });
  const retained = new BattleBundles(join(root, 'retry', 'bundles'));
  return { plan, partition, batch, reserve, run, retry, retained };
}

it('fully verifies each retained recording once for input and once in the producer scope', async () => {
  await withReplayDirectory(async (root) => {
    const { reserve, run, retry, retained } = await retainedLeague(root);
    expect(retry.index.complete).toBe(true);
    const reservation = await reserve('reuse', retry.progress.records, retained);
    const measurement = new Measurements();
    const reused = await measurement.run(() => run('reuse', reservation, { retained }));
    expect(reused.index.slots.every((slot) => slot.reused)).toBe(true);
    // Four slots each retain a truncated and a definitive replay. The retained scope decodes each
    // of the eight once; its staged import is the producer scope's one public pass. Every later
    // import, pointer and final check re-hashes bytes instead of decoding them again.
    expect(measurement.report().validation).toMatchObject({
      calls: 16,
      uniqueReplays: 8,
      repeatedCalls: 8,
    });
    expect(measurement.report().stages['validate.replay.worker']?.count).toBe(16);
    expect(measurement.report().stages['validate.replay']).toBeUndefined();
  });
}, 60000);

it('refuses a retained replay changed after the retained scope accepted it', async () => {
  await withReplayDirectory(async (root) => {
    const { reserve, run, retry, retained } = await retainedLeague(root);
    const reservation = await reserve('changed', retry.progress.records, retained);
    const original = BattleBundles.prototype.verify;
    let changed: string | undefined;
    const verify = vi.spyOn(BattleBundles.prototype, 'verify').mockImplementation(async function (
      this: BattleBundles,
      hash: string,
    ) {
      const receipt = await original.call(this, hash);
      // Only the partition's own retained scope shares this root with the fixture instance.
      if (!changed && this !== retained && this.root === retained.root) {
        const manifest = await this.manifest(receipt);
        await flipFirstByte(join(this.root, 'objects', hash.slice(7), manifest.chunks[0]!.file));
        changed = hash;
      }
      return receipt;
    });
    try {
      await expect(run('changed', reservation, { retained })).rejects.toMatchObject({
        code: 'DATA_INVALID',
      });
      expect(changed).toBeDefined();
      await expect(access(join(root, 'changed', 'results'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      verify.mockRestore();
    }
  });
}, 60000);

it('inspects retained recordings for public data before issuing a partition result', async () => {
  await withReplayDirectory(async (root) => {
    const { plan, partitions } = await planLeague(
      await privateLeagueInput(),
      batchSource,
      leagueEstimate,
    );
    const { partition, batch } = partitions[0]!;
    // Recorded outside any public scope, like a retained input that was never published.
    const prior = join(root, 'prior');
    const { index } = await runBatch(batch, prior, batchSource);
    const records = index.slots.map((slot) => ({
      simulationHash: slot.simulationHash,
      attempts: [
        {
          attempt: 1 as const,
          executionId: 'prior',
          state: slot.receipt!.result.outcome.kind,
          objectHash: slot.receipt!.objectHash,
        },
      ],
    }));
    const retained = new BattleBundles(prior);
    const reservation = await reserveLeaguePartition(plan, partition, records, 'import', retained);
    await expect(
      runLeaguePartition(
        plan,
        partition,
        batch,
        reservation,
        join(root, 'import'),
        batchSource,
        'import',
        { retained },
      ),
    ).rejects.toMatchObject({ code: 'DATA_INVALID', message: 'Private text is not publishable' });
    await expect(access(join(root, 'import', 'results'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
}, 60000);

it('borrows only an open public scope for this partition before claiming it', async () => {
  await withReplayDirectory(async (root) => {
    const { plan, partitions } = await planLeague(await leagueInput(), batchSource, leagueEstimate);
    const { partition, batch } = partitions[0]!;
    const reservation = await reserveLeaguePartition(plan, partition, [], 'borrowed');
    const output = join(root, 'borrowed'),
      pool = new BattlePool(1);
    const scope = (path: string, publicData = true, maxBytes = batch.maxOutputBytes) =>
      new BattleBundles(path, maxBytes).verificationSession({ publicData, pool });
    const closed = scope(join(output, 'bundles'));
    closed.closeVerification();
    try {
      for (const [bundles, borrowed] of [
        [scope(join(root, 'elsewhere')), pool],
        [scope(join(output, 'bundles'), false), pool],
        [scope(join(output, 'bundles'), true, batch.maxOutputBytes - 1), pool],
        [closed, pool],
        [scope(join(output, 'bundles')), undefined],
      ] as const)
        await expect(
          runLeaguePartition(
            plan,
            partition,
            batch,
            reservation,
            output,
            batchSource,
            'borrowed',
            borrowed ? { bundles, pool: borrowed } : { bundles },
          ),
        ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
      await expect(access(join(output, 'reservations'))).rejects.toMatchObject({ code: 'ENOENT' });
      const bundles = scope(join(output, 'bundles'));
      const result = await runLeaguePartition(
        plan,
        partition,
        batch,
        reservation,
        output,
        batchSource,
        'borrowed',
        { bundles, pool },
      );
      expect(result.index.complete).toBe(true);
      // The caller still owns the scope: later producer reads re-hash instead of re-decoding.
      const measurement = new Measurements();
      await measurement.run(async () => {
        for (const slot of result.index.slots) await bundles.verify(slot.receipt!.objectHash);
      });
      expect(measurement.report().validation.calls).toBe(0);
      bundles.closeVerification();
    } finally {
      await pool.close();
    }
  });
}, 60000);
