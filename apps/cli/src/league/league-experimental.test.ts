import { expect, it, vi } from 'vite-plus/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertLeagueMetadata, PublicLeagueSnapshotSchema } from '@fantasy/domain/spatial';
import { experimentalRules } from '@fantasy/samples/testing';
import { withMilestonePublication } from '../../test-support/league-milestones.ts';
import { publicationLeagueSource } from '../../test-support/leagues.ts';
import { prepareCloudLeague, finishCloudLeague } from './league-cloud.ts';
import { localPublicationGraph } from '../publication/publication-graph.ts';
import { commitPublication } from '../publication/publication-catalog.ts';
import { probeLeague, requireLeagueRestoreBinding } from './league-probe.ts';

it('keeps experimental leagues manual and separate from standard IDs scores and publication metadata', async () => {
  await withMilestonePublication(async (f) => {
    const input = await experimentalRules(structuredClone(f.definition));
    const unread = vi.fn(f.read);
    await expect(
      probeLeague(input, publicationLeagueSource.sha, unread, 'schedule'),
    ).rejects.toThrow('manual');
    expect(unread).not.toHaveBeenCalled();
    await expect(
      probeLeague(input, publicationLeagueSource.sha, f.read, 'publish'),
    ).rejects.toThrow('separate league ID');
    const before = await readFile(join(f.publicRoot, 'catalog/current.json'));
    const standard = (await localPublicationGraph(f.publicRoot)).catalog.leagues![0]!;
    await expect(
      commitPublication(f.publicRoot, [], [], {
        league: { ...standard, leagueClass: 'experimental' },
      }),
    ).rejects.toThrow('separate league ID');
    expect(await readFile(join(f.publicRoot, 'catalog/current.json'))).toEqual(before);
    expect(f.snapshot).not.toHaveProperty('leagueClass');
    await expect(assertLeagueMetadata(f.snapshot, f.revision, standard)).resolves.toBe('standard');
    await expect(
      assertLeagueMetadata({ ...f.snapshot, leagueClass: 'experimental' }, f.revision),
    ).rejects.toThrow('class mismatch');
    input.id = 'experimental-league';
    input.name = 'Experimental league';
    expect(await probeLeague(input, publicationLeagueSource.sha, f.read, 'dry-run')).toMatchObject({
      leagueClass: 'experimental',
      needed: true,
    });
    const prepared = join(f.root, 'experimental-prepared');
    await prepareCloudLeague(
      input,
      publicationLeagueSource,
      'experimental',
      f.publicRoot,
      prepared,
      { files: 0, bytes: 0, receipts: 0, usedReadRequests: 0, usedWriteRequests: 0 },
    );
    await finishCloudLeague(
      prepared,
      join(f.root, 'missing-experimental'),
      f.publicRoot,
      publicationLeagueSource,
      'experimental',
    );
    const graph = await localPublicationGraph(f.publicRoot);
    expect(graph.catalog.leagues).toHaveLength(2);
    expect(graph.catalog.leagues!.find((r) => r.id === standard.id)).toEqual(standard);
    const ref = graph.catalog.leagues!.find((r) => r.id === input.id)!;
    expect(ref.leagueClass).toBe('experimental');
    const snapshot = PublicLeagueSnapshotSchema.parse(
      JSON.parse(await readFile(join(f.publicRoot, `leagues/${ref.hash.slice(7)}.json`), 'utf8')),
    );
    const revision = JSON.parse(
      await readFile(
        join(f.publicRoot, `leagues/${snapshot.definition.hash.slice(7)}.json`),
        'utf8',
      ),
    );
    await expect(assertLeagueMetadata(snapshot, revision, ref)).resolves.toBe('experimental');
    expect(snapshot.standings.rows.map(({ detail: _, ...row }) => row)).toEqual(
      f.snapshot.standings.rows.map(({ detail: _, ...row }) => row),
    );
    expect(snapshot.standings.rows[0]!.detail.hash).not.toBe(
      f.snapshot.standings.rows[0]!.detail.hash,
    );
    const { leagueClass: _, ...unclassified } = snapshot;
    await expect(assertLeagueMetadata(unclassified, revision)).rejects.toThrow('class mismatch');
    await expect(
      commitPublication(f.publicRoot, [], [], { league: { ...ref, leagueClass: 'standard' } }),
    ).rejects.toThrow('separate league ID');
    const forbidden = await experimentalRules(structuredClone(input), ['foresight']);
    const read = vi.fn(f.read);
    await expect(
      requireLeagueRestoreBinding({}, forbidden, publicationLeagueSource.sha, read),
    ).rejects.toMatchObject({ code: 'unsupported-mechanic' });
    expect(read).not.toHaveBeenCalled();
  });
}, 30000);
