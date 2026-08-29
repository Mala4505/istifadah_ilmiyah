'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SortableTableHead, nextSort } from '@/components/ui/sortable-table-head'
import { cn } from '@/lib/utils'
import type { ColumnKey, EntriesSort, EntryEnriched, SortColumn } from './types'
import { ALL_COLUMNS, TYPE_LABELS } from './types'
import { formatDate, formatMoney, hubStatusBadgeVariant, statusBadgeVariant } from './format'

// Click-to-sort (docs/hub-screen-certification.md §3.2). Every key here is
// also a valid SortColumn (see types.ts) — the strings are identical on
// purpose, so no translation table is needed between "which column was
// clicked" and "what to sort by".
const SORTABLE_COLUMNS = new Set<ColumnKey>([
  'type',
  'date',
  'amount',
  'vendor_display_name',
  'status_label',
  'hub_status_label',
  'ubbl_number',
  'main_number',
  'budget_head_short_label',
  'document_count',
])

// Columns whose natural first-click direction is descending — newest date,
// biggest amount, most documents first (§3.2).
const DESCENDING_FIRST = new Set<SortColumn>(['date', 'amount', 'document_count'])

export function EntriesTable({
  rows,
  visibleColumns,
  loading,
  refetching = false,
  activeFilterCount,
  onClearFilters,
  selected,
  onToggleRow,
  onToggleAll,
  sort,
  onSortChange,
}: {
  rows: EntryEnriched[]
  visibleColumns: Set<ColumnKey>
  /** True only for the very first load, when there is nothing to show yet. */
  loading: boolean
  /** True while a background refetch runs over already-visible rows (§4.10). */
  refetching?: boolean
  activeFilterCount: number
  onClearFilters: () => void
  selected: Set<number>
  onToggleRow: (id: number) => void
  onToggleAll: () => void
  sort: EntriesSort
  onSortChange: (sort: EntriesSort) => void
}) {
  const router = useRouter()
  const columns = ALL_COLUMNS.filter((c) => visibleColumns.has(c.key))
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const someOnPageSelected = rows.some((r) => selected.has(r.id))

  return (
    // Phase 5 §7.7 (docs/pre-deploy-findings-and-plan.md): contain wide
    // content to a local horizontal scrollbar rather than pushing the page
    // body past the viewport.
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-9">
              <Checkbox
                aria-label="Select all rows on this page"
                checked={allOnPageSelected ? true : someOnPageSelected ? 'indeterminate' : false}
                onCheckedChange={onToggleAll}
              />
            </TableHead>
            {columns.map((col) =>
              SORTABLE_COLUMNS.has(col.key) ? (
                <SortableTableHead
                  key={col.key}
                  columnKey={col.key as SortColumn}
                  label={col.label}
                  activeColumn={sort.column}
                  direction={sort.direction}
                  align={col.align === 'right' ? 'right' : 'left'}
                  onSort={(column) => onSortChange(nextSort(sort, column, DESCENDING_FIRST))}
                />
              ) : (
                <TableHead key={col.key} className={col.align === 'right' ? 'text-right' : undefined}>
                  {col.label}
                </TableHead>
              ),
            )}
          </TableRow>
        </TableHeader>
        <TableBody className={cn(refetching && 'pointer-events-none opacity-60 transition-opacity')}>
          {loading &&
            Array.from({ length: 10 }).map((_, i) => (
              <TableRow key={`skeleton-${i}`}>
                <TableCell>
                  <Skeleton className="h-4 w-4" />
                </TableCell>
                {columns.map((col) => (
                  <TableCell key={col.key}>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                ))}
              </TableRow>
            ))}

          {!loading && rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns.length + 1} className="h-32 text-center">
                {activeFilterCount === 0 ? (
                  <p className="text-sm text-muted-foreground">No entries in this event yet.</p>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <p className="text-sm text-muted-foreground">No entries match your filters.</p>
                    <Button variant="outline" size="sm" onClick={onClearFilters}>
                      Clear all filters
                    </Button>
                  </div>
                )}
              </TableCell>
            </TableRow>
          )}

          {!loading &&
            rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={selected.has(row.id) ? 'selected' : undefined}
                className="cursor-pointer"
                onClick={() => router.push(`/entries/${row.id}`)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    aria-label={`Select entry ${row.ubbl_number}`}
                    checked={selected.has(row.id)}
                    onCheckedChange={() => onToggleRow(row.id)}
                  />
                </TableCell>
                {columns.map((col, colIndex) => (
                  <TableCell key={col.key} className={cn(col.align === 'right' && 'text-right tabular-nums')}>
                    {colIndex === 0 ? (
                      // §4.1: the first visible cell is a real link — keyboard
                      // reachable, and middle-click / cmd-click open a new tab.
                      // The row onClick stays for plain mouse convenience.
                      <Link
                        href={`/entries/${row.id}`}
                        className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {renderCell(row, col.key)}
                      </Link>
                    ) : (
                      renderCell(row, col.key)
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
        </TableBody>
      </Table>
    </div>
  )
}

function renderCell(row: EntryEnriched, key: ColumnKey) {
  switch (key) {
    case 'type':
      return <Badge variant="outline">{TYPE_LABELS[row.type] ?? row.type}</Badge>
    case 'ubbl_number':
      return (
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono text-xs">{row.ubbl_number}</span>
          {row.is_void && <Badge variant="destructive">Void</Badge>}
        </span>
      )
    case 'main_number':
      return <span className="font-mono text-xs">{row.main_number ?? '—'}</span>
    case 'department_name':
      return row.department_name ?? '—'
    case 'budget_head_short_label':
      return row.budget_head_short_label ?? row.budget_head_raw_label ?? '—'
    case 'admin_head_name':
      return row.admin_head_name ?? <span className="text-muted-foreground">unassigned</span>
    case 'zone_name':
      return row.zone_name ?? <span className="text-muted-foreground">unassigned</span>
    case 'cost_center_name':
      return row.cost_center_name ?? <span className="text-muted-foreground">unassigned</span>
    case 'vendor_display_name':
      return row.vendor_display_name ?? row.vendor_raw ?? '—'
    case 'invoice_number':
      return row.invoice_number ?? '—'
    case 'date':
      return formatDate(row.date)
    case 'amount':
      return formatMoney(row.amount)
    case 'status_label':
      return row.status_label ? (
        <Badge variant={statusBadgeVariant(row.status_label, row.status_code)}>{row.status_label}</Badge>
      ) : (
        '—'
      )
    case 'hub_status_label':
      return <Badge variant={hubStatusBadgeVariant(row.hub_status_code)}>{row.hub_status_label}</Badge>
    case 'export_pending':
      return row.hub_status_exported_at === null && row.hub_status_code !== 'not_set' ? (
        <Badge variant="warning">Pending</Badge>
      ) : (
        <span className="text-muted-foreground">—</span>
      )
    case 'document_count':
      return row.document_count > 0 ? row.document_count : <span className="text-muted-foreground">0</span>
    default:
      return null
  }
}
