import { useMemo, useState } from 'react';
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import type { PublicLeagueSnapshot } from '@fantasy/domain/spatial';
import { leagueLink } from './league-route.ts';
import { leagueInterval, leaguePercent, compareLeagueScore } from './league-presentation.ts';
import { DataTable } from './DataTable.tsx';

export function LeagueTable({ snapshot, hash }: { snapshot: PublicLeagueSnapshot; hash: string }) {
  type Row = PublicLeagueSnapshot['standings']['rows'][number];
  const [sorting, setSorting] = useState<SortingState>([]);
  const formal = snapshot.standings.status === 'formal';
  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      { accessorKey: formal ? 'rank' : 'displayOrder', header: formal ? '順位' : '表示順' },
      {
        id: 'name',
        accessorFn: (r) => snapshot.characters.find((c) => c.id === r.character)!.name,
        header: 'キャラクター',
        cell: ({ row, getValue }) => (
          <a href={leagueLink(hash, row.original.character)}>{getValue<string>()}</a>
        ),
      },
      {
        id: 'score',
        accessorFn: (r) => r.overall.lower,
        header: '総合得点',
        sortingFn: (a, b) => compareLeagueScore(a.original.overall.lower, b.original.overall.lower),
        cell: ({ row }) => leagueInterval(row.original.overall),
      },
      {
        id: 'completion',
        accessorFn: (r) => r.overall.counts.planned - r.overall.counts.unresolved,
        header: '勝敗確定率',
        cell: ({ row }) => leaguePercent(row.original.overall.completion),
      },
      {
        id: 'counts',
        header: '勝 / 引分 / 負 / 未確定',
        enableSorting: false,
        cell: ({ row }) => {
          const c = row.original.overall.counts;
          return `${c.wins} / ${c.draws} / ${c.losses} / ${c.unresolved}`;
        },
      },
      {
        id: 'rates',
        header: '勝率 / 引分率 / 敗率',
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original.overall;
          return (
            <>
              {leaguePercent(s.winRate)} / {leaguePercent(s.drawRate)} / {leaguePercent(s.lossRate)}
              <small>分母: 予定{s.counts.planned}枠</small>
            </>
          );
        },
      },
    ],
    [snapshot, hash, formal],
  );
  const table = useReactTable({
    data: snapshot.standings.rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (r) => r.character,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  return (
    <section className="panel league-results" aria-label="リーグ順位表">
      {snapshot.leagueClass === 'experimental' && <p>実験リーグの順位表</p>}
      <h2>{formal ? '正式ランキング' : '暫定ランキング'}</h2>
      <p>
        {formal
          ? '厳密な得点が等しいキャラクターは同じ順位です。'
          : '未確定の枠を含む得点区間です。下限による表示順であり、区間が重なる相手との順位は未確定です。'}
      </p>
      <p>列の並べ替えは表示だけを変えます。確定した順位を変更しません。</p>
      <p>横にスクロールして全列を確認できます。</p>
      <DataTable table={table} label="リーグ順位表" />
    </section>
  );
}
