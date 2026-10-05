'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Filter, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SelectNative } from '@/components/ui/select-native'
import { PaginationBar } from '@/components/ui/pagination-bar'
import { TableHead } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { toCellValue, type CellValue } from '@/lib/table-values'

/**
 * Client-side search / filter / sort / pagination for any list whose rows
 * are already all on the page (2026-10-05: "every table has pagination,
 * search, filter and sorting"). Two ways in:
 *
 *   - `useTableControls(items, { columns })` — for tables that render their
 *     own rows (inline-edit settings tables keep per-row state, so they page
 *     the *data* and render their existing row components).
 *   - `<InteractiveTable>` (interactive-table.tsx) — for read-only tables;
 *     built on this same hook.
 */

export type ControlColumn<T> = {
  key: string
  label: ReactNode
  /** The value this column searches / filters / sorts on. */
  value: (item: T) => string | number | boolean | null | undefined
  /** Filter dropdown: true/false forces it; default is automatic (text
   *  columns with 2–60 distinct values). */
  filter?: boolean
  /** Sort on this instead of `value` (e.g. a date's timestamp). */
  sortValue?: (item: T) => string | number | boolean | null | undefined
  /** Text for the dropdown option (defaults to the value). */
  filterLabel?: (item: T) => string
  /** Whether this column takes part in search (default true). */
  searchable?: boolean
  sortable?: boolean
  descendingFirst?: boolean
}

export type SortState = { key: string; direction: 'asc' | 'desc' } | null

const DEFAULT_PAGE_SIZES = [10, 25, 50, 100, 200]
const MAX_FILTER_OPTIONS = 60

function compareValues(a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'en-IN', { numeric: true, sensitivity: 'base' })
}

function textOf(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

function sortValueOf(v: unknown): CellValue {
  if (typeof v === 'boolean') return v ? 1 : 0
  return toCellValue(v)
}

export function useTableControls<T>(
  items: T[],
  {
    columns,
    initialPageSize = 25,
    initialSort = null,
    searchPlaceholder = 'Search…',
    noun = 'row',
    toolbarExtra,
  }: {
    columns: ControlColumn<T>[]
    initialPageSize?: number
    initialSort?: SortState
    searchPlaceholder?: string
    noun?: string
    toolbarExtra?: ReactNode
  }
) {
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [showFilters, setShowFilters] = useState(false)
  const [sort, setSort] = useState<SortState>(initialSort)
  const [pageSize, setPageSize] = useState(initialPageSize)
  const [page, setPage] = useState(0)

  const filterOptions = useMemo(() => {
    const out: { column: ControlColumn<T>; options: string[] }[] = []
    for (const col of columns) {
      if (col.filter === false) continue
      const distinct = new Set<string>()
      let numeric = 0
      for (const item of items) {
        const raw = col.value(item)
        const text = col.filterLabel ? col.filterLabel(item) : textOf(raw)
        if (text) distinct.add(text)
        if (typeof (col.sortValue ? col.sortValue(item) : raw) === 'number') numeric += 1
        if (distinct.size > MAX_FILTER_OPTIONS) break
      }
      const auto = numeric <= items.length / 2 && distinct.size >= 2 && distinct.size <= MAX_FILTER_OPTIONS
      if ((col.filter === true || auto) && distinct.size > 0) {
        out.push({
          column: col,
          options: Array.from(distinct).sort((a, b) => a.localeCompare(b, 'en-IN', { numeric: true })),
        })
      }
    }
    return out
  }, [columns, items])

  const activeFilterCount = Object.values(filters).filter(Boolean).length

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    let out = items
    if (q) {
      const searchCols = columns.filter((c) => c.searchable !== false)
      out = out.filter((item) => searchCols.some((c) => textOf(c.value(item)).toLowerCase().includes(q)))
    }
    const active = Object.entries(filters).filter(([, v]) => v)
    if (active.length > 0) {
      out = out.filter((item) =>
        active.every(([key, v]) => {
          const col = columns.find((c) => c.key === key)
          if (!col) return true
          const text = col.filterLabel ? col.filterLabel(item) : textOf(col.value(item))
          return text === v
        })
      )
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key)
      if (col) {
        const dir = sort.direction === 'asc' ? 1 : -1
        out = [...out].sort((a, b) => {
          const get = col.sortValue ?? col.value
          const av = sortValueOf(get(a))
          const bv = sortValueOf(get(b))
          if (av === null || bv === null) return compareValues(av, bv)
          return compareValues(av, bv) * dir
        })
      }
    }
    return out
  }, [items, columns, query, filters, sort])

  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const pageItems = visible.slice(safePage * pageSize, safePage * pageSize + pageSize)

  function toggleSort(key: string) {
    setPage(0)
    setSort((prev) => {
      if (prev?.key === key) return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
      const col = columns.find((c) => c.key === key)
      return { key, direction: col?.descendingFirst ? 'desc' : 'asc' }
    })
  }

  const pageSizeOptions = DEFAULT_PAGE_SIZES.includes(initialPageSize)
    ? DEFAULT_PAGE_SIZES
    : [...DEFAULT_PAGE_SIZES, initialPageSize].sort((a, b) => a - b)

  const toolbar = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(0)
            }}
            placeholder={searchPlaceholder}
            aria-label="Search this table"
            className="h-8 pl-8 text-xs"
          />
        </div>
        {filterOptions.length > 0 && (
          <Button
            type="button"
            variant={showFilters || activeFilterCount > 0 ? 'secondary' : 'outline'}
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
          >
            <Filter className="h-3.5 w-3.5" aria-hidden="true" />
            Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Button>
        )}
        {(query || activeFilterCount > 0) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={() => {
              setQuery('')
              setFilters({})
              setPage(0)
            }}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Clear
          </Button>
        )}
        {toolbarExtra && <div className="ml-auto flex items-center gap-2">{toolbarExtra}</div>}
      </div>
      {showFilters && filterOptions.length > 0 && (
        <div className="grid gap-2 rounded-md border border-border bg-muted/30 p-2 [grid-template-columns:repeat(auto-fill,minmax(10rem,1fr))]">
          {filterOptions.map(({ column, options }) => (
            <label
              key={column.key}
              className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-muted-foreground"
            >
              {column.label}
              <SelectNative
                className="h-8 text-xs normal-case tracking-normal"
                value={filters[column.key] ?? ''}
                onChange={(e) => {
                  setFilters((prev) => ({ ...prev, [column.key]: e.target.value }))
                  setPage(0)
                }}
              >
                <option value="">All</option>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </SelectNative>
            </label>
          ))}
        </div>
      )}
    </div>
  )

  const pagination = (
    <PaginationBar
      rangeStart={visible.length === 0 ? 0 : safePage * pageSize + 1}
      rangeEnd={visible.length === 0 ? -1 : safePage * pageSize + pageItems.length}
      total={visible.length}
      pageSize={pageSize}
      pageSizeOptions={pageSizeOptions}
      onPageSizeChange={(size) => {
        setPageSize(size)
        setPage(0)
      }}
      canPrev={safePage > 0}
      canNext={safePage < pageCount - 1}
      onPrev={() => setPage(safePage - 1)}
      onNext={() => setPage(safePage + 1)}
      noun={noun}
    />
  )

  /** A clickable `<TableHead>` for a column key. */
  function header(key: string, opts?: { align?: 'left' | 'right'; className?: string; label?: ReactNode }) {
    const col = columns.find((c) => c.key === key)
    return (
      <SortHeader
        key={key}
        label={opts?.label ?? col?.label ?? key}
        active={sort?.key === key}
        direction={sort?.direction ?? 'asc'}
        sortable={col !== undefined && col.sortable !== false}
        onSort={() => toggleSort(key)}
        align={opts?.align}
        className={opts?.className}
      />
    )
  }

  return {
    pageItems,
    visibleCount: visible.length,
    totalCount: items.length,
    filtered: query.trim() !== '' || activeFilterCount > 0,
    sort,
    toggleSort,
    toolbar,
    pagination,
    header,
  }
}

export function SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  if (!active) return <ArrowUpDown className="h-3 w-3 text-muted-foreground/50" aria-hidden="true" />
  return direction === 'asc' ? (
    <ArrowUp className="h-3 w-3" aria-hidden="true" />
  ) : (
    <ArrowDown className="h-3 w-3" aria-hidden="true" />
  )
}

function SortHeader({
  label,
  active,
  direction,
  sortable,
  onSort,
  align = 'left',
  className,
}: {
  label: ReactNode
  active: boolean
  direction: 'asc' | 'desc'
  sortable: boolean
  onSort: () => void
  align?: 'left' | 'right'
  className?: string
}) {
  return (
    <TableHead
      className={cn(align === 'right' && 'text-right', className)}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : sortable ? 'none' : undefined}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className={cn(
            '-m-2 inline-flex select-none items-center gap-1 rounded-sm p-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            align === 'right' && 'flex-row-reverse'
          )}
        >
          {label}
          <SortIcon active={active} direction={direction} />
        </button>
      ) : (
        label
      )}
    </TableHead>
  )
}
