import { expect, it } from 'vite-plus/test';
import { leagueFiles, leagueGenerations } from '../../../../e2e/league-fixtures.ts';
import { publicLibrary } from '../replay/public-source.ts';
import { leagueSnapshot, leagueDetail, leaguePair, leaguePairMatches } from './league-source.ts';
import { openReplay } from '../replay/open-replay.ts';

function libraryFixture(corrupt = '') {
  const requests: string[] = [];
  const library = publicLibrary('https://example.test/', async (input) => {
    const key = new URL(String(input)).pathname.slice(1);
    requests.push(key);
    const data = leagueFiles.get(key);
    return new Response(key === corrupt ? '{}' : data ? new Uint8Array(data) : null, {
      status: data ? 200 : 404,
      headers: { 'content-type': key.endsWith('.gz') ? 'application/gzip' : 'application/json' },
    });
  });
  return { library, requests };
}
it('loads only the overview, then authenticates selected slots and the exact saved replay', async () => {
  const { library, requests } = libraryFixture();
  const catalog = await library.catalog();
  const snapshot = await leagueSnapshot(library, leagueGenerations[1]!.hash);
  expect(requests).toHaveLength(3);
  expect(snapshot.standings).toMatchObject({ planned: 24, resolved: 24, status: 'formal' });
  expect(snapshot.standings.rows.map((r) => r.rank)).toEqual([1, 1, 1]);
  const detail = await leagueDetail(library, snapshot, 'character-0');
  const pair = await leaguePair(library, snapshot, detail, 'character-1', 0);
  const matches = await leaguePairMatches(library, catalog, snapshot, pair);
  expect(matches).toHaveLength(8);
  expect(requests.some((k) => k.startsWith('objects/'))).toBe(false);
  expect(new Set(matches.map((m) => m.planned.slot.placement)).size).toBe(2);
  expect(new Set(matches.map((m) => m.row.seed)).size).toBe(2);
  expect(new Set(matches.map((m) => m.row.scenario.id)).size).toBe(2);
  const selected = matches[0]!.row;
  const replay = await openReplay(library.source(selected));
  expect(replay.manifest).toMatchObject({
    simulationHash: selected.simulationHash,
    attemptId: selected.replay!.attemptId,
    resultId: selected.replay!.resultId,
  });
  const altered = structuredClone(pair);
  altered.rows[0]!.rowId = 'sha256:' + 'f'.repeat(64);
  await expect(leaguePairMatches(library, catalog, snapshot, altered)).rejects.toMatchObject({
    kind: 'damaged',
  });
});
it('keeps historical provisional denominators and rejects corrupt or foreign details', async () => {
  const { library } = libraryFixture();
  const snapshot = await leagueSnapshot(library, leagueGenerations[0]!.hash);
  expect(snapshot.standings).toMatchObject({ planned: 24, resolved: 12, status: 'provisional' });
  expect(
    snapshot.standings.rows.every((r) => r.rank === null && r.overall.counts.planned === 16),
  ).toBe(true);
  const ref = snapshot.standings.rows[0]!.detail;
  await expect(
    leagueDetail(
      libraryFixture(`leagues/${ref.hash.slice(7)}.json`).library,
      snapshot,
      snapshot.standings.rows[0]!.character,
    ),
  ).rejects.toMatchObject({ kind: 'damaged' });
  await expect(leagueDetail(library, snapshot, 'not-a-participant')).rejects.toMatchObject({
    kind: 'damaged',
  });
});
