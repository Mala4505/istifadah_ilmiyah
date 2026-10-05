'use client'

import { Fragment, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SortableTableHead, nextSort } from '@/components/ui/sortable-table-head'
import { PaginationBar } from '@/components/ui/pagination-bar'
import { cn } from '@/lib/utils'
import type { ColumnKey, EntriesSort, EntryEnriched, SortColumn } from './types'
import { ALL_COLUMNS, TYPE_LABELS } from './types'
import { formatDate, formatMoney } from './format'
import { DESCENDING_FIRST, renderCell } from './entries-table'

type VendorGroup = {
  key: string
  label: string
  rows: EntryEnriched[]
  amount: number
  documents: number
  latestDate: string | null
}

/** Plural nouns for "N distinct …" summaries in a group row. */
const DISTINCT_NOUN: Partial<Record<ColumnKey, string>> = {
  type: 'types',
  department_name: 'departments',
  budget_head_short_label: 'heads',
  admin_head_name: 'admin heads',
  zone_name: 'zones',
  status_label: 'statuses',
  invoice_number: 'invoices',
  main_number: 'main #s',
}

function fieldValue(row: EntryEnriched, key: SortColumn): string | number | null {
  if (key === 'type') return TYPE_LABELS[row.type] ?? row.type
  if (key === 'vendor_display_name') return row.vendor_display_name ?? row.vendor_raw ?? null
  const v = (row as unknown as Record<string, unknown>)[key]
  return v === undefined || v === null || v === '' ? null : (v as string | number)
}

function compare(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'en-IN', { numeric: true, sensitivity: 'base' })
}

/** Sort rows by the active column; blanks always last, `id desc` as tiebreak. */
function sortRows(rows: EntryEnriched[], sort: EntriesSort): EntryEnriched[] {
  const dir = sort.direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = fieldValue(a, sort.column)
    const bv = fieldValue(b, sort.column)
    const c = av === null || bv === null ? compare(av, bv) : compare(av, bv) * dir
    return c !== 0 ? c : b.id - a.id
  })
}

/** The value a whole vendor group sorts on for the active column. */
function groupSortValue(g: VendorGroup, column: SortColumn): string | number | null {
  switch (column) {
    case 'id':
    case 'amount':
      return g.amount
    case 'document_count':
      return g.documents
    case 'date':
      return g.latestDate
    case 'vendor_display_name':
      return g.label
    default:
      return summaryText(g.rows, column as ColumnKey)
  }
}

/** One text column's summary across a group: the value if they all agree,
 *  otherwise "N distinct …". */
function summaryText(rows: EntryEnriched[], key: ColumnKey): string | null {
  const distinct = new Set<string>()
  for (const r of rows) {
    const v = fieldValue(r, key as SortColumn)
    if (v !== null) distinct.add(String(v))
  }
  if (distinct.size === 0) return null
  if (distinct.size === 1) return Array.from(distinct)[0]!
  return `${distinct.size} ${DISTINCT_NOUN[key] ?? 'values'}`
}

function dateRange(rows: EntryEnriched[]): string {
  const dates = rows.map((r) => r.date).filter((d): d is string => Boolean(d)).sort()
  if (dates.length === 0) return '—'
  const first = formatDate(dates[0]!)
  const last = formatDate(dates[dates.length - 1]!)
  return first === last ? first : `${first} – ${last}`
}

function GroupCell({ group, keyName }: { group: VendorGroup; keyName: ColumnKey }) {
  switch (keyName) {
    case 'ubbl_number':
      return (
        <span className="text-muted-foreground">
          {group.rows.length.toLocaleString('en-IN')} {group.rows.length === 1 ? 'entry' : 'entries'}
        </span>
      )
    case 'amount':
      return <span className="font-semibold">{formatMoney(group.amount)}</span>
    case 'document_count':
      return <span className="font-semibold">{group.documents.toLocaleString('en-IN')}</span>
    case 'date':
      return <span className="text-muted-foreground">{dateRange(group.rows)}</span>
    case 'vendor_display_name':
      return <span className="font-semibold">{group.label}</span>
    default: {
      const text = summaryText(group.rows, keyName)
      if (text === null) return <span className="text-muted-foreground">—</span>
      const mixed = /^\d+ /.test(text) && text.endsWith(DISTINCT_NOUN[keyName] ?? 'values')
      return <span className={cn(mixed && 'text-muted-foreground')}>{text}</span>
    }
  }
}

/**
 * Vendor-grouped ("Group") view of the Entries list (2026-10-05). Every
 * matching entry is rolled up under its vendor — one accordion row per
 * vendor carrying the vendor's totals in each column (entry count, amount,
 * bills, date range, and the shared value or "N distinct" for text columns).
 * Clicking anywhere on a vendor row expands it to that vendor's individual
 * entries; clicking an entry row opens the entry.
 *
 * Sorting reorders the vendor groups by their totals (and the entries within
 * each group by the same column). Pagination is per vendor group.
 */
export function EntriesGroupedTable({
  rows,
  visibleColumns,
  loading,
  truncated,
  selected,
  onToggleIds,
  sort,
  onSortChange,
}: {
  rows: EntryEnriched[]
  visibleColumns: Set<ColumnKey>
  loading: boolean
  truncated: boolean
  selected: Set<number>
  /** Select (true) or deselect (false) a set of entry ids at once. */
  onToggleIds: (ids: number[], select: boolean) => void
  sort: EntriesSort
  onSortChange: (sort: EntriesSort) => void
}) {
  const router = useRouter()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pageSize, setPageSize] = useState(25)
  const [page, setPage] = useState(0)

  // Vendor is the group itself, so it always leads the row; the rest follow
  // the column chooser.
  const columns = ALL_COLUMNS.filter((c) => c.key !== 'vendor_display_name' && visibleColumns.has(c.key))

  const groups = useMemo(() => {
    const map = new Map<string, VendorGroup>()
    for (const r of rows) {
      const label = r.vendor_display_name ?? r.vendor_raw ?? 'No vendor'
      const key = r.vendor_id !== null ? `v${r.vendor_id}` : `raw:${label.toLowerCase()}`
      let g = map.get(key)
      if (!g) {
        g = { key, label, rows: [], amount: 0, documents: 0, latestDate: null }
        map.set(key, g)
      }
      g.rows.push(r)
      g.amount += r.amount ?? 0
      g.documents += r.document_count ?? 0
      if (r.date && (g.latestDate === null || r.date > g.latestDate)) g.latestDate = r.date
    }
    // Default `id` sort means "no column picked" — biggest vendors first.
    const effective: EntriesSort = sort.column === 'id' ? { column: 'amount', direction: 'desc' } : sort
    const dir = effective.direction === 'asc' ? 1 : -1
    const list = Array.from(map.values()).map((g) => ({ ...g, rows: sortRows(g.rows, effective) }))
    list.sort((a, b) => {
      const av = groupSortValue(a, effective.column)
      const bv = groupSortValue(b, effective.column)
      const c = av === null || bv === null ? compare(av, bv) : compare(av, bv) * dir
      return c !== 0 ? c : a.label.localeCompare(b.label)
    })
    return list
  }, [rows, sort])

  const grandTotal = useMemo(() => rows.reduce((s, r) => s + (r.amount ?? 0), 0), [rows])
  const grandDocs = useMemo(() => rows.reduce((s, r) => s + (r.document_count ?? 0), 0), [rows])

  const pageCount = Math.max(1, Math.ceil(groups.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const pageGroups = groups.slice(safePage * pageSize, safePage * pageSize + pageSize)

  function toggleGroup(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const allExpanded = pageGroups.length > 0 && pageGroups.every((g) => expanded.has(g.key))
  const colSpan = columns.length + 2

  return (
    <div className="flex flex-col gap-3">
      {!loading && groups.length > 0 && (
        <div className="-mb-1 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setExpanded(allExpanded ? new Set() : new Set(pageGroups.map((g) => g.key)))}
          >
            {allExpanded ? 'Collapse all' : 'Expand all'}
          </Button>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-9" />
              <SortableTableHead
                columnKey={'vendor_display_name' as SortColumn}
                label="Vendor"
                activeColumn={sort.column}
                direction={sort.direction}
                onSort={(column) => onSortChange(nextSort(sort, column, DESCENDING_FIRST))}
              />
              {columns.map((col) => (
                <SortableTableHead
                  key={col.key}
                  columnKey={col.key as SortColumn}
                  label={col.label}
                  activeColumn={sort.column}
                  direction={sort.direction}
                  align={col.align === 'right' ? 'right' : 'left'}
                  onSort={(column) => onSortChange(nextSort(sort, column, DESCENDING_FIRST))}
                />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading &&
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={`skeleton-${i}`}>
                  <TableCell>
                    <Skeleton className="h-4 w-4" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-40" />
                  </TableCell>
                  {columns.map((col) => (
                    <TableCell key={col.key}>
                      <Skeleton className="h-4 w-20" />
                    </TableCell>
                  ))}
                </TableRow>
              ))}

            {!loading && groups.length === 0 && (
              <TableRow>
                <TableCell colSpan={colSpan} className="h-32 text-center text-sm text-muted-foreground">
                  No entries match your filters.
                </TableCell>
              </TableRow>
            )}

            {!loading &&
              pageGroups.map((g) => {
                const open = expanded.has(g.key)
                const ids = g.rows.map((r) => r.id)
                const allSel = ids.every((id) => selected.has(id))
                const someSel = !allSel && ids.some((id) => selected.has(id))
                return (
                  <Fragment key={g.key}>
                    <TableRow
                      className="cursor-pointer bg-muted/30 hover:bg-muted/60"
                      aria-expanded={open}
                      tabIndex={0}
                      onClick={() => toggleGroup(g.key)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          toggleGroup(g.key)
                        }
                      }}
                    >
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          aria-label={`Select all ${g.rows.length} entries for ${g.label}`}
                          checked={allSel ? true : someSel ? 'indeterminate' : false}
                          onCheckedChange={() => onToggleIds(ids, !allSel)}
                        />
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5">
                          {open ? (
                            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                          )}
                          <GroupCell group={g} keyName="vendor_display_name" />
                          <Badge variant="outline" className="ml-1 font-mono text-[10px]">
                            {g.rows.length}
                          </Badge>
                        </span>
                      </TableCell>
                      {columns.map((col) => (
                        <TableCell key={col.key} className={cn(col.align === 'right' && 'text-right tabular-nums')}>
                          <GroupCell group={g} keyName={col.key} />
                        </TableCell>
                      ))}
                    </TableRow>

                    {open &&
                      g.rows.map((row) => (
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
                              onCheckedChange={() => onToggleIds([row.id], !selected.has(row.id))}
                            />
                          </TableCell>
                          <TableCell className="pl-10 text-muted-foreground">
                            <Link
                              href={`/entries/${row.id}`}
                              className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {row.vendor_display_name ?? row.vendor_raw ?? '—'}
                            </Link>
                          </TableCell>
                          {columns.map((col) => (
                            <TableCell key={col.key} className={cn(col.align === 'right' && 'text-right tabular-nums')}>
                              {renderCell(row, col.key)}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                  </Fragment>
                )
              })}
          </TableBody>
          {!loading && groups.length > 0 && (
            <TableFooter>
              <TableRow>
                <TableCell />
                <TableCell className="text-xs uppercase tracking-wide text-muted-foreground">
                  Total · {groups.length.toLocaleString('en-IN')} vendors · {rows.length.toLocaleString('en-IN')} entries
                </TableCell>
                {columns.map((col) => (
                  <TableCell key={col.key} className={cn(col.align === 'right' && 'text-right tabular-nums')}>
                    {col.key === 'amount' ? formatMoney(grandTotal) : col.key === 'document_count' ? grandDocs.toLocaleString('en-IN') : null}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </div>

      {truncated && (
        <p className="text-xs text-muted-foreground">
          Showing totals for the first 20,000 matching entries — narrow the filters to group the rest.
        </p>
      )}

      {!loading && groups.length > 0 && (
        <PaginationBar
          rangeStart={safePage * pageSize + 1}
          rangeEnd={safePage * pageSize + pageGroups.length}
          total={groups.length}
          pageSize={pageSize}
          onPageSizeChange={(size) => {
            setPageSize(size)
            setPage(0)
          }}
          canPrev={safePage > 0}
          canNext={safePage < pageCount - 1}
          onPrev={() => setPage(safePage - 1)}
          onNext={() => setPage(safePage + 1)}
          noun="vendor"
        />
      )}
    </div>
  )
}

export function ViewModeSwitch({ mode, onChange }: { mode: 'single' | 'group'; onChange: (m: 'single' | 'group') => void }) {
  return (
    <div role="radiogroup" aria-label="Table view: single entries or grouped by vendor" className="inline-flex rounded-md border border-border bg-card p-0.5">
      {(['single', 'group'] as const).map((m) => (
        <Button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          variant={mode === m ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={() => onChange(m)}
        >
          {m === 'single' ? 'Single' : 'Group'}
        </Button>
      ))}
    </div>
  )
}
