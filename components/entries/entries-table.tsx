'use client'

import { useRouter } from 'next/navigation'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { ColumnKey, EntryEnriched } from './types'
import { ALL_COLUMNS } from './types'
import { formatDate, formatMoney, hubStatusBadgeVariant, statusBadgeVariant, varianceBadgeVariant } from './format'

export function EntriesTable({
  rows,
  visibleColumns,
  loading,
  selected,
  onToggleRow,
  onToggleAll,
}: {
  rows: EntryEnriched[]
  visibleColumns: Set<ColumnKey>
  loading: boolean
  selected: Set<number>
  onToggleRow: (id: number) => void
  onToggleAll: () => void
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
            {columns.map((col) => (
              <TableHead key={col.key} className={col.align === 'right' ? 'text-right' : undefined}>
                {col.label}
              </TableHead>
            ))}
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
    case 'head_name':
      return row.head_name ?? <span className="text-muted-foreground">unassigned</span>
    case 'zone_name':
      return row.zone_name ?? <span className="text-muted-foreground">unassigned</span>
    case 'vendor_display_name':
      return row.vendor_display_name ?? row.vendor_raw ?? '—'
    case 'invoice_number':
      return row.invoice_number ?? '—'
    case 'date':
      return formatDate(row.date)
    case 'tenant_amount':
      return formatMoney(row.tenant_amount)
    case 'main_amount':
      return formatMoney(row.main_amount)
    case 'amount_variance':
      return row.amount_variance ? (
        <Badge variant={varianceBadgeVariant(row.amount_variance)}>{formatMoney(row.amount_variance)}</Badge>
      ) : (
        <span className="text-muted-foreground">—</span>
      )
    case 'tenant_status_label':
      return row.tenant_status_label ? (
        <Badge variant={statusBadgeVariant(row.tenant_status_label)}>{row.tenant_status_label}</Badge>
      ) : (
        '—'
      )
    case 'main_status_label':
      return row.main_status_label ? (
        <Badge variant={statusBadgeVariant(row.main_status_label)}>{row.main_status_label}</Badge>
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
