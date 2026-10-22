'use client';

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/common/states';

/**
 * Server-driven table: the API does filtering, sorting and pagination; this renders the current
 * page with consistent loading, empty and error states.
 *
 * columns: [{ key, header, cell: (row) => node, sortKey?, className? }]
 */
export function DataTable({ caption, columns, rows, rowKey = 'id', isPending, error, onRetry, empty, sort, onSortChange, skeletonRows = 6, scrollable = false }) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;

  const sortIcon = (key) => {
    if (sort?.replace('-', '') !== key) return <ArrowUpDown className="size-3.5 opacity-50" aria-hidden />;
    return sort.startsWith('-') ? <ArrowDown className="size-3.5" aria-hidden /> : <ArrowUp className="size-3.5" aria-hidden />;
  };
  const ariaSort = (key) => (sort?.replace('-', '') !== key ? 'none' : sort.startsWith('-') ? 'descending' : 'ascending');

  return (
    <Table scrollLabel={scrollable ? caption : undefined}>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <tr>
          {columns.map((col) => (
            <TableHead key={col.key} className={col.className} aria-sort={col.sortKey ? ariaSort(col.sortKey) : undefined}>
              {col.sortKey && onSortChange ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-foreground"
                  onClick={() => onSortChange(sort === col.sortKey ? `-${col.sortKey}` : col.sortKey)}
                >
                  {col.header}
                  {sortIcon(col.sortKey)}
                </button>
              ) : (
                col.header
              )}
            </TableHead>
          ))}
        </tr>
      </TableHeader>
      <TableBody>
        {isPending ? (
          Array.from({ length: skeletonRows }, (_, i) => (
            <TableRow key={i}>
              {columns.map((col) => (
                <TableCell key={col.key}>
                  <Skeleton className="h-4 w-full max-w-40" />
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length}>{empty ?? <EmptyState title="Nothing here yet" />}</td>
          </tr>
        ) : (
          rows.map((row) => (
            <TableRow key={row[rowKey]}>
              {columns.map((col) => (
                <TableCell key={col.key} className={col.className}>
                  {col.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

/** Previous/next navigation over an API cursor, keeping a stack of earlier cursors. */
export function CursorPagination({ cursors, nextCursor, onPrevious, onNext, isFetching }) {
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-2 border-t px-4 py-3 text-sm">
      <span className="text-muted-foreground">Page {cursors.length + 1}</span>
      <div className="flex gap-2">
        <button type="button" className="rounded-md border px-3 py-1.5 disabled:opacity-50" disabled={cursors.length === 0 || isFetching} onClick={onPrevious}>
          Previous
        </button>
        <button type="button" className="rounded-md border px-3 py-1.5 disabled:opacity-50" disabled={!nextCursor || isFetching} onClick={onNext}>
          Next
        </button>
      </div>
    </nav>
  );
}
