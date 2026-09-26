import { expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { withReplayDirectory } from '@fantasy/api/testing';
import { BattleBundles } from '@fantasy/api/artifacts';
import { reserveLeaguePartition } from '@fantasy/api/tooling';
import { leagueFixture } from '@fantasy/samples/testing';
import { leaguePublicationFixture } from '../../test-support/leagues.ts';
import { buildLeagueWork, finishLeagueWork } from './league-work.ts';
import { exportLeague, leagueFile } from './league-export.ts';
import { commitPublication } from '../publication/publication-catalog.ts';
import { localPublicationGraph } from '../publication/publication-graph.ts';
import { leagueFailure } from './league-diagnostics.ts';
import { probeLeague } from './league-probe.ts';

function initialWork(fixture: Awaited<ReturnType<typeof leaguePublicationFixture>>) {
  return buildLeagueWork(
    fixture.plan,
    fixture.partitions,
    fixture.reservations,
    [],
    { ref: null, records: [] },
    fixture.executionId,
  );
}

it('classifies a cached progress page referenced as a reservation as saved data', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await leaguePublicationFixture(join(root, 'run'));
    const target = join(root, 'public');
    const work = await initialWork(fixture);
    const progress = work.work.progress[0]!;
    const forged = leagueFile({
      ...work.work,
      reservations: [{ ...work.work.reservations[0]!, hash: progress.hash, bytes: progress.bytes }],
    });
    await commitPublication(target, [...work.files, forged.file], [], { leagueWork: forged.ref });
    const error = await localPublicationGraph(target).then(
      () => null,
      (error: unknown) => error,
    );
    expect(leagueFailure(error, { command: 'prepare' })).toMatchObject({ code: 'DATA_INVALID' });
  });
}, 30000);

it('rejects a new execution that reserves retry 2 but flattens only attempt 1', async () => {
  await withReplayDirectory(async (root) => {
    const definition = await leagueFixture(2, 1);
    definition.budget.maxEvents = 1;
    const fixture = await leaguePublicationFixture(join(root, 'run'), { definition });
    const target = join(root, 'public');
    const initial = await initialWork(fixture);
    await commitPublication(target, initial.files, [], { leagueWork: initial.ref });
    const retained = new BattleBundles(target);
    const finished = await finishLeagueWork(
      fixture.plan,
      fixture.reservations,
      fixture.completed,
      initial,
      retained,
    );
    await exportLeague(fixture.plan, fixture.partitions, fixture.completed, target, finished);
    await expect(localPublicationGraph(target)).resolves.toBeDefined();
    const retry = await reserveLeaguePartition(
      fixture.plan,
      fixture.partitions[0]!.partition,
      finished.records,
      'next-day',
      retained,
    );
    expect(retry.progress.records.every((r) => r.attempts.at(-1)!.attempt === 2)).toBe(true);
    const admitted = await buildLeagueWork(
      fixture.plan,
      fixture.partitions,
      [retry],
      [],
      finished,
      'next-day',
      retained,
    );
    const forged = leagueFile({ ...admitted.work, progress: finished.work.progress });
    await commitPublication(target, [...admitted.files, forged.file], [], {
      leagueWork: forged.ref,
    });
    await expect(localPublicationGraph(target)).rejects.toMatchObject({
      code: 'DATA_INVALID',
      message: 'New execution journal omits its reserved attempts',
    });
  });
}, 30000);

it('checks every catalog league identity before deduplicating retained snapshots', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await leaguePublicationFixture(join(root, 'run'));
    const target = join(root, 'public');
    await exportLeague(fixture.plan, fixture.partitions, fixture.completed, target);
    const graph = await localPublicationGraph(target);
    const ref = graph.catalog.leagues![0]!;
    await commitPublication(target, [], [], {
      league: { ...ref, inputHash: 'sha256:' + 'f'.repeat(64) },
    });
    await expect(localPublicationGraph(target)).rejects.toThrow(
      'Conflicting league catalog reference',
    );
    await expect(
      probeLeague(fixture.plan.revision.definition, fixture.plan.source.sha, (key) =>
        readFile(join(target, key)),
      ),
    ).rejects.toMatchObject({ code: 'DATA_INVALID', message: 'League probe catalog identity' });
  });
}, 30000);

it('checks repeated work sizes before deduplicating retained journals', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await leaguePublicationFixture(join(root, 'run'));
    const target = join(root, 'public');
    const work = await initialWork(fixture);
    await commitPublication(target, work.files, [], { leagueWork: work.ref });
    await commitPublication(target, [], [], {
      leagueWork: { ...work.ref, bytes: work.ref.bytes + 1 },
    });
    await expect(localPublicationGraph(target)).rejects.toThrow('Conflicting league work size');
  });
}, 30000);
