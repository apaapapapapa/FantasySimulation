import { useMemo, useState } from 'react';
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import type { PublicMatchRow } from '@fantasy/domain/spatial';
import { DataTable } from './DataTable.tsx';
import { matchLink } from './match-route.ts';
import { matchDuration, matchResult, playbackLabels, reasonLabels } from './match-presentation.ts';

const columns: ColumnDef<PublicMatchRow>[] = [
  {
    id: 'participants',
    accessorFn: (r) =>
      r.participants
        .map((p) => `${p.character.name} (${p.character.id}) r${p.character.revision}`)
        .join(' / '),
    header: '参加者',
    cell: ({ row, getValue }) => (
      <>
        <span>{getValue<string>()}</span>
        <details>
          <summary>設定・開始位置</summary>
          <ul>
            {row.original.participants.map((p) => (
              <li key={p.actorId}>
                参加枠 {p.actorId}: {p.character.name} · 位置 (mm): {p.position.x}, {p.position.y},{' '}
                {p.position.z} · 向き: {p.facing.x}, {p.facing.y}, {p.facing.z} · 乱数枠{' '}
                {p.rngStream}
              </li>
            ))}
          </ul>
          <pre>
            {JSON.stringify(
              {
                slotId: row.original.slotId,
                ruleset: row.original.ruleset,
                simulationHash: row.original.simulationHash,
                replay: row.original.replay,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </>
    ),
  },
  {
    id: 'scenario',
    accessorFn: (r) => `${r.scenario.name} (${r.scenario.id}) r${r.scenario.revision}`,
    header: '戦場',
  },
  { accessorKey: 'seed', header: 'seed' },
  {
    accessorKey: 'state',
    header: '状態',
    cell: ({ row }) => (
      <>
        {row.original.state}
        <small>
          {reasonLabels[row.original.reason]}
          {row.original.reused ? ' / 保存結果を再利用' : ''}
        </small>
      </>
    ),
  },
  {
    id: 'result',
    accessorFn: matchResult,
    header: '結果',
    cell: ({ row, getValue }) => (
      <>
        {getValue<string>()}
        <small>{matchDuration(row.original)}</small>
      </>
    ),
  },
];
export function MatchTable({
  rows,
  setHash,
  page,
}: {
  rows: PublicMatchRow[];
  setHash: string;
  page: number;
}) {
  const [sorting, setSorting] = useState<SortingState>([]),
    [filter, setFilter] = useState('');
  const displayColumns = useMemo<ColumnDef<PublicMatchRow>[]>(
    () => [
      ...columns,
      {
        id: 'replay',
        header: 'リプレイ',
        enableSorting: false,
        cell: ({ row }) => (
          <>
            <small>{playbackLabels[row.original.playback]}</small>
            {row.original.replay ? (
              <a
                href={matchLink(setHash, page, row.original.slotId)}
                aria-label={`リプレイを開く ${row.original.slotId}`}
              >
                {row.original.playback === 'partial' ? '記録済み範囲を開く' : '開く'}
              </a>
            ) : (
              <span>{reasonLabels[row.original.reason]}</span>
            )}
          </>
        ),
      },
    ],
    [setHash, page],
  );
  const table = useReactTable({
    data: rows,
    columns: displayColumns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getRowId: (row) => `${row.slotId}:${row.simulationHash}`,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  return (
    <>
      <p>絞り込みと並べ替えは、このページ内の表示に適用されます。順位表ではありません。</p>
      <label>
        このページを絞り込み
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      <DataTable table={table} label="公開試合一覧" />
      <p>
        {table.getRowModel().rows.length} / {rows.length}件を表示
      </p>
    </>
  );
}
