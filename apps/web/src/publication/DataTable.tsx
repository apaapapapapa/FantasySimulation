import { flexRender, type Table } from '@tanstack/react-table';

export function DataTable<T>({ table, label }: { table: Table<T>; label: string }) {
  return (
    <div
      className="data-table-scroll"
      role="region"
      aria-label={`${label}のスクロール領域`}
      tabIndex={0}
    >
      <table aria-label={label}>
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
                  {header.column.getCanSort() ? (
                    <button onClick={header.column.getToggleSortingHandler()}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      <span className="sort-indicator" aria-hidden="true">
                        {header.column.getIsSorted() === 'asc'
                          ? '↑'
                          : header.column.getIsSorted() === 'desc'
                            ? '↓'
                            : '↕'}
                      </span>
                    </button>
                  ) : (
                    flexRender(header.column.columnDef.header, header.getContext())
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
