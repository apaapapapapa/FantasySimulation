import { expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import { leagueInput, leagueEstimate } from '../../test-support/leagues.ts';
import { batchSource } from '../../test-support/batches.ts';
import { withReplayDirectory } from '../../test-support/replays.ts';
import { planLeague } from './league-plan.ts';
import { reserveLeaguePartition, runLeaguePartition } from './league-runner.ts';
import { Measurements } from '../measurements.ts';
import { BattleBundles } from '../batch/battle-bundle.ts';

it('measures real Worker/persistence/reverification without changing results or planned identities', async () => {
  await withReplayDirectory(async (root) => {
    const { plan, partitions } = await planLeague(await leagueInput(), batchSource, leagueEstimate);
    const { partition, batch } = partitions[0]!;
    const reservation = await reserveLeaguePartition(plan, partition, [], 'measurement');
    const run = (suffix: string) =>
      runLeaguePartition(
        plan,
        partition,
        batch,
        reservation,
        join(root, suffix),
        batchSource,
        'measurement',
      );
    const baseline = await run('baseline');
    const measurement = new Measurements();
    const candidate = await measurement.run(() => run('measured'));
    expect(
      candidate.index.slots.map((s) => ({
        slot: s.slotId,
        simulation: s.simulationHash,
        state: s.state,
        result: s.receipt?.result,
        hash: s.receipt?.resultHash,
      })),
    ).toEqual(
      baseline.index.slots.map((s) => ({
        slot: s.slotId,
        simulation: s.simulationHash,
        state: s.state,
        result: s.receipt?.result,
        hash: s.receipt?.resultHash,
      })),
    );
    const report = measurement.report();
    expect(report.matchWallMs.count).toBe(4);
    expect(
      report.matches.every(
        (m) => m.worker && Number(m.worker.computeMs) > 0 && Number(m.worker.dispatchWaitMs) >= 0,
      ),
    ).toBe(true);
    expect(report.validation.calls).toBe(12); // Writer seal, bundle publish, producer scope; final check rehashes.
    expect(report.validation.uniqueReplays).toBe(4);
    expect(report.validation.repeatedCalls).toBe(8);
    expect(report.stages['db.walCheckpoint']?.count).toBe(4);
    // Every stored record, including each match's deferred terminal record, is one append span.
    const bundles = new BattleBundles(join(root, 'measured', 'bundles'));
    let records = 0;
    for (const slot of candidate.index.slots)
      if (slot.receipt) records += (await bundles.manifest(slot.receipt)).records;
    expect(records).toBeGreaterThan(4);
    expect(report.stages['record.append']?.count).toBe(records);
    expect(report.stages.decompress?.count).toBeGreaterThan(0);
    expect(report.stages['json.records']?.count).toBeGreaterThan(0);
    expect(report.stages['hash.bytes']?.count).toBeGreaterThan(0);
    expect(report.stages['save.write']?.bytes).toBeGreaterThan(0);
    expect(report.capacitySampleMaxBytes.db).toBeGreaterThan(0);
    expect(report.cpu.userMs + report.cpu.systemMs).toBeGreaterThan(0);
    expect(report.measuredSpanUnionMs).toBeLessThanOrEqual(report.wallMs);
    expect(report.incompleteSpans).toBe(0);
  });
}, 30000);
