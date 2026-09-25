import { expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  LeaguePartitionResultSchema,
  PublicLeagueSnapshotSchema,
  PublicLeagueDetailSchema,
  PublicLeagueSlotPageSchema,
  PublicMatchPageSchema,
  type LeagueFileRef,
} from '@fantasy/domain/spatial';
import { withReplayDirectory } from '@fantasy/api/testing';
import { planLeague, reserveLeaguePartition } from '@fantasy/api/tooling';
import { BattleBundles } from '@fantasy/api/artifacts';
import { leagueFixture, leagueEstimate } from '@fantasy/samples/testing';
import { leaguePublicationFixture, publicationLeagueSource } from '../../test-support/leagues.ts';
import { exportLeague, leagueFile } from './league-export.ts';
import { buildLeagueWork, finishLeagueWork } from './league-work.ts';
import { localPublicationGraph } from '../publication/publication-graph.ts';
import { commitPublication } from '../publication/publication-catalog.ts';

async function leagueJson(root: string, ref: LeagueFileRef) {
  return JSON.parse(
    await readFile(join(root, 'leagues', ref.hash.slice(7) + '.json'), 'utf8'),
  ) as unknown;
}

it('publishes all scheduled partitions, lazy pair pages and exact scores in one generation', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await leaguePublicationFixture(join(root, 'run'), { size: 2 });
    const target = join(root, 'public');
    const exported = await exportLeague(
      fixture.plan,
      fixture.partitions,
      fixture.completed,
      target,
    );
    expect(exported).toMatchObject({
      status: 'formal',
      planned: 4,
      resolved: 4,
      missingPartitions: [],
    });
    const graph = await localPublicationGraph(target);
    expect(graph.catalog.previousCatalogHash).toBeNull();
    expect(graph.catalog.sets).toHaveLength(2);
    const ref = graph.catalog.leagues![0]!;
    const snapshot = PublicLeagueSnapshotSchema.parse(await leagueJson(target, ref));
    const detail = PublicLeagueDetailSchema.parse(
      await leagueJson(target, snapshot.standings.rows[0]!.detail),
    );
    const pair = PublicLeagueSlotPageSchema.parse(
      await leagueJson(target, detail.opponents[0]!.pages[0]!),
    );
    expect(pair.rows).toHaveLength(4);
    for (const row of pair.rows) {
      const page = PublicMatchPageSchema.parse(
        JSON.parse(
          await readFile(
            join(target, 'sets', row.setHash.slice(7), row.pageHash.slice(7) + '.json'),
            'utf8',
          ),
        ),
      );
      expect(page.rows.find((r) => r.slotId === row.rowId)?.simulationHash).toBe(
        row.slot.simulationHash,
      );
    }
    const repeated = await exportLeague(
      fixture.plan,
      fixture.partitions,
      fixture.completed,
      target,
    );
    expect(repeated.catalogHash).toBe(exported.catalogHash);
    expect(repeated.addedFiles).toBe(0);
    const forged = structuredClone(snapshot);
    forged.standings.rows[0]!.overall.lower = { numerator: '51', denominator: '1' };
    const fake = leagueFile(forged);
    await commitPublication(target, [fake.file], [], { league: { ...ref, ...fake.ref } });
    await expect(localPublicationGraph(target)).rejects.toThrow(/score mismatch/);
  });
}, 30000);

it('keeps absent partitions in the denominator and writes durable reservations before computation', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await leaguePublicationFixture(join(root, 'run'), { size: 2 });
    const work = await buildLeagueWork(
      fixture.plan,
      fixture.partitions,
      fixture.reservations,
      [],
      { ref: null, records: [] },
      fixture.executionId,
    );
    const target = join(root, 'public');
    await commitPublication(target, work.files, [], { leagueWork: work.ref });
    const initial = await localPublicationGraph(target);
    expect(initial.catalog.leagueWork).toEqual(work.ref);
    expect(initial.catalog.sets).toEqual([]);
    expect(work.records.every((r) => r.attempts[0]!.state === 'reserved')).toBe(true);
    const finished = await finishLeagueWork(
      fixture.plan,
      fixture.reservations,
      fixture.completed.slice(0, 1),
      work,
      new BattleBundles(target),
    );
    const missing = await exportLeague(
      fixture.plan,
      fixture.partitions,
      fixture.completed.slice(0, 1),
      target,
      finished,
    );
    expect(missing).toMatchObject({
      status: 'provisional',
      planned: 4,
      resolved: 2,
      missingPartitions: [1],
    });
    await expect(localPublicationGraph(target)).resolves.toBeDefined();
    const reset = [];
    for (const { partition } of fixture.partitions)
      reset.push(await reserveLeaguePartition(fixture.plan, partition, [], 'incorrect-reset'));
    const rewritten = await buildLeagueWork(
      fixture.plan,
      fixture.partitions,
      reset,
      [],
      { ref: finished.ref, records: [] },
      'incorrect-reset',
    );
    await commitPublication(target, rewritten.files, [], { leagueWork: rewritten.ref });
    await expect(localPublicationGraph(target)).rejects.toThrow(/rewrites consumed attempts/);
  });
}, 30000);

it('retains the first partial snapshot and receipt after the one larger-budget retry completes', async () => {
  await withReplayDirectory(async (root) => {
    const definition = await leagueFixture(2, 1);
    definition.budget.maxEvents = 1;
    const first = await leaguePublicationFixture(join(root, 'first'), {
      definition,
      executionId: 'initial',
    });
    const target = join(root, 'public');
    const partial = await exportLeague(first.plan, first.partitions, first.completed, target);
    const prior = LeaguePartitionResultSchema.parse(first.completed[0]!.result);
    const next = await leaguePublicationFixture(join(root, 'retry'), {
      definition,
      executionId: 'retry',
      history: prior.progress.records,
      retained: first.completed[0]!.bundles,
    });
    const complete = await exportLeague(next.plan, next.partitions, next.completed, target);
    expect(complete).toMatchObject({ status: 'formal', planned: 4, resolved: 4 });
    const graph = await localPublicationGraph(target);
    expect(graph.objects.size).toBe(8);
    expect(
      PublicLeagueSnapshotSchema.parse(await leagueJson(target, partial.snapshot)).standings.status,
    ).toBe('provisional');
    expect(graph.catalog.leagues![0]!.hash).toBe(complete.snapshot.hash);
  });
}, 30000);

it('reuses existing pair results after adding a participant and recalculates every score denominator', async () => {
  await withReplayDirectory(async (root) => {
    const first = await leaguePublicationFixture(join(root, 'first'));
    const prior = LeaguePartitionResultSchema.parse(first.completed[0]!.result);
    const definition = await leagueFixture(3, 1);
    const planned = await planLeague(
      definition,
      publicationLeagueSource,
      leagueEstimate,
      prior.progress.records,
      first.completed[0]!.bundles,
    );
    expect(planned.estimate).toMatchObject({ planned: 12, reused: 4, compute: 8 });
    const next = await leaguePublicationFixture(join(root, 'added'), {
      definition,
      executionId: 'added',
      history: prior.progress.records,
      retained: first.completed[0]!.bundles,
    });
    const target = join(root, 'public');
    await exportLeague(first.plan, first.partitions, first.completed, target);
    await exportLeague(next.plan, next.partitions, next.completed, target);
    const graph = await localPublicationGraph(target);
    const snapshot = PublicLeagueSnapshotSchema.parse(
      await leagueJson(target, graph.catalog.leagues![0]!),
    );
    expect(snapshot.standings.rows.map((r) => r.overall.counts.planned)).toEqual([8, 8, 8]);
    expect(snapshot.standings).toMatchObject({ status: 'formal', planned: 12, resolved: 12 });
  });
}, 30000);
