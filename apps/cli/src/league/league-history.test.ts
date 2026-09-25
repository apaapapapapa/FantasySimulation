import { expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { withReplayDirectory } from '@fantasy/api/testing';
import { planLeague, reserveLeaguePartition, runLeaguePartition } from '@fantasy/api/tooling';
import { leagueFixture, leagueSource } from '@fantasy/samples/testing';
import { readLeagueHistory } from './league-history.ts';

it('reads generated result and reservation envelopes directly and rejects altered history', async () => {
  await withReplayDirectory(async (root) => {
    const source = {
      sha: leagueSource,
      node: '24.19.0',
      platform: 'linux' as const,
      arch: 'x64' as const,
    };
    const { plan, partitions } = await planLeague(await leagueFixture(2, 1), source, {
      matchesPerPlan: 10,
      estimatedMsPerMatch: 1,
      estimatedBytesPerMatch: 1,
      estimatedFilesPerMatch: 2,
      retainedBytes: 0,
      retainedFiles: 0,
      maxReadRequests: 100000,
      maxWriteRequests: 100000,
      usedReadRequests: 0,
      usedWriteRequests: 0,
    });
    const { partition, batch } = partitions[0]!;
    const reservation = await reserveLeaguePartition(plan, partition, [], 'first');
    const output = join(root, 'run');
    const result = await runLeaguePartition(
      plan,
      partition,
      batch,
      reservation,
      output,
      source,
      'first',
    );
    expect(await readLeagueHistory(join(output, 'results'))).toEqual(result.progress.records);
    expect(await readLeagueHistory(join(output, 'reservations'))).toEqual(
      reservation.progress.records,
    );
    const file = join(root, 'reservation.json');
    await writeFile(file, JSON.stringify(reservation));
    expect(await readLeagueHistory(file)).toEqual(reservation.progress.records);
    reservation.executionId = 'altered';
    await writeFile(file, JSON.stringify(reservation));
    await expect(readLeagueHistory(file)).rejects.toThrow(/checksum/);
  });
}, 30000);
