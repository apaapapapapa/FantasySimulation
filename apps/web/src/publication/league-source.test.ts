import { expect, it } from 'vite-plus/test';
import { canonicalJson, contentHash } from '@fantasy/domain/spatial';
import { leagueFiles, leagueGenerations } from '../../../../e2e/league-fixtures.ts';
import { publicLibrary } from '../replay/public-source.ts';
import { leagueSnapshot, leagueDetail, leaguePair, leaguePairMatches } from './league-source.ts';
import { openReplay } from '../replay/open-replay.ts';

function libraryFixture(corrupt = '', files = leagueFiles) {
  const requests: string[] = [];
  const library = publicLibrary('https://example.test/', async (input) => {
    const key = new URL(String(input)).pathname.slice(1);
    requests.push(key);
    const data = files.get(key);
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
  // The pinned definition authenticates standard/experimental classification before display.
  expect(requests).toHaveLength(4);
  expect(requests.at(-1)).toBe(`leagues/${snapshot.definition.hash.slice(7)}.json`);
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
  altered.rows[0]!.cancelled = true;
  await expect(leaguePairMatches(library, catalog, snapshot, altered)).rejects.toMatchObject({
    kind: 'damaged',
  });
  delete altered.rows[0]!.cancelled;
  altered.rows[0]!.rowId = 'sha256:' + 'f'.repeat(64);
  await expect(leaguePairMatches(library, catalog, snapshot, altered)).rejects.toMatchObject({
    kind: 'damaged',
  });
});
it.each(['duplicate', 'foreign', 'unordered'] as const)(
  'rejects checksum-valid pair pages with %s slots',
  async (kind) => {
    const { library } = libraryFixture();
    const snapshot = await leagueSnapshot(library, leagueGenerations[1]!.hash);
    const detail = await leagueDetail(library, snapshot, 'character-0');
    const pair = await leaguePair(library, snapshot, detail, 'character-1', 0);
    if (kind === 'duplicate') pair.rows[1] = structuredClone(pair.rows[0]!);
    else if (kind === 'foreign') pair.rows[0]!.slot.characters[1]!.id = 'character-2';
    else pair.rows.reverse();
    const bytes = Buffer.from(canonicalJson(pair));
    const hash = await contentHash(pair);
    detail.opponents.find((o) => o.character === 'character-1')!.pages[0] = {
      hash,
      bytes: bytes.byteLength,
      rows: pair.rows.length,
    };
    const files = new Map(leagueFiles).set(`leagues/${hash.slice(7)}.json`, bytes);
    await expect(
      leaguePair(libraryFixture('', files).library, snapshot, detail, 'character-1', 0),
    ).rejects.toMatchObject({ kind: 'damaged' });
  },
);
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
