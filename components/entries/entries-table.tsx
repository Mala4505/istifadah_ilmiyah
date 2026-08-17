'use client'

import { useRouter } from 'next/navigation'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { ColumnKey, EntriesSort, EntryEnriched, SortColumn } from './types'
import { ALL_COLUMNS } from './types'
import { formatDate, formatMoney, hubStatusBadgeVariant, statusBadgeVariant } from './format'

// Click-to-sort (hub-refinements-plan.md §1/§2): "amount, date, vendor, status
// at minimum". Each key here is also a valid SortColumn (see types.ts) — the
// values are identical strings on purpose, so no translation table is needed
// between "which column was clicked" and "what to sort by".
const SORTABLE_COLUMNS = new Set<ColumnKey>(['date', 'amount', 'vendor_display_name', 'status_label'])

export function EntriesTable({
  rows,
  visibleColumns,
  loading,
  selected,
  onToggleRow,
  onToggleAll,
  sort,
  onSortChange,
}: {
  rows: EntryEnriched[]
  visibleColumns: Set<ColumnKey>
  loading: boolean
  selected: Set<number>
  onToggleRow: (id: number) => void
  onToggleAll: () => void
  sort: EntriesSort
  onSortChange: (column: SortColumn) => void
}) {
  const router = useRouter()
  const columns = ALL_COLUMNS.filter((c) => visibleColumns.has(c.key))
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const someOnPageSelected = rows.some((r) => selected.has(r.id))

  return (
    <div className="rounded-lg border border-border">
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
            {columns.map((col) => {
              const sortable = SORTABLE_COLUMNS.has(col.key)
              const isActive = sortable && sort.column === col.key
              return (
                <TableHead
                  key={col.key}
                  className={col.align === 'right' ? 'text-right' : undefined}
                  aria-sort={isActive ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      className={cn(
                        'inline-flex items-center gap-1 select-none hover:text-foreground',
                        col.align === 'right' && 'flex-row-reverse'
                      )}
                      onClick={() => onSortChange(col.key as SortColumn)}
                    >
                      {col.label}
                      {isActive ? (
                        sort.direction === 'asc' ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 text-muted-foreground/50" />
                      )}
                    </button>
                  ) : (
                    col.label
                  )}
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
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
              <TableCell colSpan={columns.length + 1} className="h-32 text-center text-sm text-muted-foreground">
                No entries match your filters.
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
                {columns.map((col) => (
                  <TableCell key={col.key} className={cn(col.align === 'right' && 'text-right tabular-nums')}>
                    {renderCell(row, col.key)}
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
    case 'ubbl_number':
      return <span className="font-mono text-xs">{row.ubbl_number}</span>
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
        <Badge variant={statusBadgeVariant(row.status_label)}>{row.status_label}</Badge>
      ) : (
        '—'
      )
    case 'audit_status_label':
      return row.audit_status_label ? (
        <Badge variant={statusBadgeVariant(row.audit_status_label)}>{row.audit_status_label}</Badge>
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
