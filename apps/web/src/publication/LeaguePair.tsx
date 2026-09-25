import { useCallback, useMemo, useState } from 'react';
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import type {
  PublicCatalog,
  PublicLeagueSnapshot,
  PublicLeagueDetail,
} from '@fantasy/domain/spatial';
import type { PublicLibrary } from '../replay/public-source.ts';
import { leaguePair, leaguePairMatches } from './league-source.ts';
import { leagueLink, type LeagueRoute } from './league-route.ts';
import { matchResult, playbackLabels, reasonLabels } from './match-presentation.ts';
import { usePublicData } from './use-public-data.ts';
import { DataTable } from './DataTable.tsx';
import { SelectedMatch } from './SelectedMatch.tsx';

type Match = Awaited<ReturnType<typeof leaguePairMatches>>[number];
export function LeaguePair({
  library,
  catalog,
  snapshot,
  detail,
  route,
}: {
  library: PublicLibrary;
  catalog: PublicCatalog;
  snapshot: PublicLeagueSnapshot;
  detail: PublicLeagueDetail;
  route: LeagueRoute;
}) {
  const read = useCallback(
    async (signal: AbortSignal) => {
      const pair = await leaguePair(library, snapshot, detail, route.opponent!, route.page, signal);
      return leaguePairMatches(library, catalog, snapshot, pair, signal);
    },
    [library, catalog, snapshot, detail, route.opponent, route.page],
  );
  const data = usePublicData(read);
  if (data?.error) return <p role="alert">{data.error}</p>;
  if (!data?.value) return <p role="status">対戦ペアの試合を読み込んでいます</p>;
  const selected = data.value.find((m) => m.planned.slot.id === route.slot);
  return (
    <>
      <section className="panel league-results" aria-label="リーグ所属試合">
        <h2>
          {[route.character, route.opponent]
            .map((id) => snapshot.characters.find((c) => c.id === id)?.name)
            .join(' 対 ')}
        </h2>
        <p>各行が1試合です。未確定の試合も予定枠に残ります。</p>
        <p>横にスクロールして全列を確認できます。</p>
        <label>
          対戦ペアのページ
          <select
            value={route.page}
            onChange={(e) => {
              window.location.hash = leagueLink(
                route.snapshot,
                route.character,
                route.opponent,
                Number(e.target.value),
              );
            }}
          >
            {detail.opponents
              .find((o) => o.character === route.opponent)!
              .pages.map((ref, i) => (
                <option key={ref.hash} value={i}>
                  {i + 1}ページ
                </option>
              ))}
          </select>
        </label>
        <PairTable matches={data.value} route={route} />
      </section>
      {route.slot && !selected && <p role="alert">指定した予定枠はこのページにありません</p>}
      {selected && (
        <>
          <p>
            リーグ予定枠: <code aria-label="リーグ予定枠">{selected.planned.slot.id}</code>
          </p>
          <SelectedMatch
            library={library}
            row={selected.row}
            back={leagueLink(route.snapshot, route.character, route.opponent, route.page)}
          />
        </>
      )}
    </>
  );
}
function PairTable({ matches, route }: { matches: Match[]; route: LeagueRoute }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const columns = useMemo<ColumnDef<Match>[]>(
    () => [
      { id: 'field', accessorFn: (m) => m.row.scenario.name, header: '戦場' },
      {
        id: 'placement',
        accessorFn: (m) => (m.planned.slot.placement === 'normal' ? '通常' : '交換'),
        header: '配置',
      },
      { id: 'trial', accessorFn: (m) => m.planned.slot.trial + 1, header: '試行' },
      { id: 'seed', accessorFn: (m) => m.row.seed, header: 'seed' },
      {
        id: 'result',
        accessorFn: (m) => matchResult(m.row),
        header: '結果',
        cell: ({ row }) => (
          <>
            {matchResult(row.original.row)}
            <small>
              {row.original.row.state} · {reasonLabels[row.original.row.reason]}
            </small>
          </>
        ),
      },
      {
        id: 'replay',
        header: '記録',
        enableSorting: false,
        cell: ({ row }) => (
          <>
            <small>{playbackLabels[row.original.row.playback]}</small>
            <a
              href={leagueLink(
                route.snapshot,
                route.character,
                route.opponent,
                route.page,
                row.original.planned.slot.id,
              )}
              aria-label={`リーグ試合を開く ${row.original.planned.slot.id}`}
            >
              {row.original.row.replay
                ? row.original.row.playback === 'partial'
                  ? '記録済み範囲を開く'
                  : 'リプレイを開く'
                : '状態を確認'}
            </a>
          </>
        ),
      },
    ],
    [route],
  );
  const table = useReactTable({
    data: matches,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (m) => m.planned.slot.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  return <DataTable table={table} label="リーグ所属試合" />;
}
