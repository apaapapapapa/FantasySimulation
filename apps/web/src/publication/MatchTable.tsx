import { useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { publicHashName, type PublicMatchRow } from '@fantasy/domain/spatial';

const columns: ColumnDef<PublicMatchRow>[] = [
  {
    id: 'participants',
    accessorFn: (r) =>
      r.participants.map((p) => `${p.character.name} r${p.character.revision}`).join(' / '),
    header: '参加者',
    cell: ({ row, getValue }) => (
      <>
        <span>{getValue<string>()}</span>
        <details>
          <summary>設定・開始位置</summary>
          <pre>
            {JSON.stringify(
              {
                participants: row.original.participants,
                ruleset: row.original.ruleset,
                simulationHash: row.original.simulationHash,
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
    accessorFn: (r) => `${r.scenario.name} r${r.scenario.revision}`,
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
          {row.original.reason}
          {row.original.reused ? ' / 保存結果を再利用' : ''}
        </small>
      </>
    ),
  },
  {
    id: 'result',
    accessorFn: (r) => r.result?.outcome.kind ?? '未確定',
    header: '結果',
    cell: ({ row, getValue }) => (
      <>
        {getValue<string>()}
        <small>
          {row.original.result ? `${row.original.result.steps} step` : '結果なし'} ·{' '}
          {row.original.playback}
        </small>
      </>
    ),
  },
];
export function matchLink(setHash: string, page: number, slotId?: string) {
  return `#/sets/${publicHashName(setHash)}/pages/${page}${slotId ? `/matches/${publicHashName(slotId)}` : ''}`;
}
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
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getRowId: (row) => row.slotId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  return (
    <>
      <label>
        このページを絞り込み
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      <table aria-label="公開試合一覧">
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th
                  key={header.id}
                  aria-sort={
                    header.column.getIsSorted() === 'asc'
                      ? 'ascending'
                      : header.column.getIsSorted() === 'desc'
                        ? 'descending'
                        : 'none'
                  }
                >
                  <button onClick={header.column.getToggleSortingHandler()}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </button>
                </th>
              ))}
              <th>リプレイ</th>
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
              <td>
                {row.original.replay ? (
                  <a
                    href={matchLink(setHash, page, row.original.slotId)}
                    aria-label={`リプレイを開く ${row.original.slotId}`}
                  >
                    開く
                  </a>
                ) : (
                  <span>記録なし</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {table.getRowModel().rows.length} / {rows.length}件を表示
      </p>
    </>
  );
}
