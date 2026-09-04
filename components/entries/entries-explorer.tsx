'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { FriendlyError } from '@/components/ui/friendly-error'
import { Building2, Download, RotateCcw, Tag } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PaginationBar } from '@/components/ui/pagination-bar'
import { FilterBar, countActiveFilters } from './filter-bar'
import { ColumnChooser } from './column-chooser'
import { EntriesTable } from './entries-table'
import { StatusCountChips, type EntryStatusCount } from './status-count-chips'
import { BulkStatusDialog } from './bulk-status-dialog'
import { BulkEnrichmentDialog } from './bulk-enrichment-dialog'
import { exportEntriesToCsv } from './csv-export'
import { fetchEntriesPage, fetchAllMatchingIds, type PageCursor } from './query'
import { ALL_COLUMNS, DEFAULT_FILTERS, DEFAULT_SORT, PAGE_SIZE } from './types'
import type { ColumnKey, EntriesFilters, EntriesSort, EntryEnriched, FilterOptions, SortColumn, SortDirection } from './types'
import { NewEntryDialog } from './new-entry-dialog'
import { isAdminOrAbove, type StaffRole } from '@/lib/auth/roles'

function filtersToSearchParams(filters: EntriesFilters): URLSearchParams {
  const sp = new URLSearchParams()
  if (filters.type) sp.set('tp', filters.type)
  if (filters.department) sp.set('dept', filters.department)
  if (filters.budgetHead) sp.set('bh', filters.budgetHead)
  if (filters.adminHead) sp.set('ahead', filters.adminHead)
  if (filters.zone) sp.set('zone', filters.zone)
  if (filters.costCenter) sp.set('cc', filters.costCenter)
  if (filters.status) sp.set('st', filters.status)
  if (filters.hubStatus) sp.set('hs', filters.hubStatus)
  if (filters.exportPending) sp.set('exp', '1')
  if (filters.dateFrom) sp.set('from', filters.dateFrom)
  if (filters.dateTo) sp.set('to', filters.dateTo)
  if (filters.vendor) sp.set('vendor', filters.vendor)
  if (filters.vendorId) sp.set('vid', filters.vendorId)
  if (filters.hasVariance) sp.set('var', '1')
  if (filters.hasDocument) sp.set('doc', '1')
  return sp
}

function searchParamsToFilters(sp: URLSearchParams): EntriesFilters {
  // The canonical param is the short form (`dept`, `bh`, `zone`, `cc`, `vid`).
  // The long `*_id` aliases are accepted too so the Reports drill-through links
  // (`/entries?department_id=…`, `?vendor_id=…`, …) land filtered rather than on
  // an unscoped list — the next filter change rewrites the URL to the short form.
  return {
    type: sp.get('tp') ?? '',
    department: sp.get('dept') ?? sp.get('department_id') ?? '',
    budgetHead: sp.get('bh') ?? sp.get('budget_head_id') ?? '',
    adminHead: sp.get('ahead') ?? sp.get('admin_head_id') ?? '',
    zone: sp.get('zone') ?? sp.get('zone_id') ?? '',
    costCenter: sp.get('cc') ?? sp.get('cost_center_id') ?? '',
    status: sp.get('st') ?? '',
    hubStatus: sp.get('hs') ?? '',
    exportPending: sp.get('exp') === '1',
    dateFrom: sp.get('from') ?? '',
    dateTo: sp.get('to') ?? '',
    vendor: sp.get('vendor') ?? '',
    vendorId: sp.get('vid') ?? sp.get('vendor_id') ?? '',
    hasVariance: sp.get('var') === '1',
    hasDocument: sp.get('doc') === '1',
  }
}

// Sort state gets the same URL-sync treatment as filters (hub-refinements-plan.md
// §1/§2): "a sorted view stays copy-pasteable." Only written to the URL when it
// differs from the default.
const SORT_COLUMNS: SortColumn[] = [
  'id',
  'type',
  'amount',
  'date',
  'vendor_display_name',
  'status_label',
  'ubbl_number',
  'main_number',
  'budget_head_short_label',
  'hub_status_label',
  'document_count',
]

function sortToSearchParams(sort: EntriesSort): URLSearchParams {
  const sp = new URLSearchParams()
  if (sort.column !== DEFAULT_SORT.column) sp.set('sort', sort.column)
  if (sort.direction !== DEFAULT_SORT.direction) sp.set('dir', sort.direction)
  return sp
}

function searchParamsToSort(sp: URLSearchParams): EntriesSort {
  const column = sp.get('sort')
  const direction = sp.get('dir')
  return {
    column: (SORT_COLUMNS as string[]).includes(column ?? '') ? (column as SortColumn) : DEFAULT_SORT.column,
    direction: direction === 'asc' || direction === 'desc' ? (direction as SortDirection) : DEFAULT_SORT.direction,
  }
}

/** The full URL query string for a given filter+sort state — one serializer,
 * used both to write the URL and to compare against an incoming one (§4.7). */
function serializeState(filters: EntriesFilters, sort: EntriesSort): string {
  const sp = filtersToSearchParams(filters)
  for (const [key, value] of sortToSearchParams(sort)) sp.set(key, value)
  return sp.toString()
}

function sortsEqual(a: EntriesSort, b: EntriesSort): boolean {
  return a.column === b.column && a.direction === b.direction
}

function filtersEqual(a: EntriesFilters, b: EntriesFilters): boolean {
  return (Object.keys(a) as (keyof EntriesFilters)[]).every((k) => a[k] === b[k])
}

/** True when `next` differs from `prev` only in the free-text vendor field —
 * the one input that should debounce (§4.7). */
function onlyVendorChanged(prev: EntriesFilters, next: EntriesFilters): boolean {
  if (prev.vendor === next.vendor) return false
  return (Object.keys(next) as (keyof EntriesFilters)[]).every((k) => k === 'vendor' || prev[k] === next[k])
}

const COLUMNS_STORAGE_KEY = 'entries.visibleColumns.v1'

function defaultVisibleColumns(): Set<ColumnKey> {
  return new Set(ALL_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key))
}

/** Reads the persisted column choice (§4.6). Returns null when there is
 * nothing valid stored, so the caller can skip an unnecessary state update. */
function loadStoredColumns(): Set<ColumnKey> | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(COLUMNS_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const valid = new Set(ALL_COLUMNS.map((c) => c.key))
    const restored = parsed.filter((k): k is ColumnKey => typeof k === 'string' && valid.has(k as ColumnKey))
    return restored.length > 0 ? new Set(restored) : null
  } catch {
    return null
  }
}

// Phase 5 §8.1 (docs/pre-deploy-findings-and-plan.md): the filter-dropdown
// lookups and the viewer's own role/department-ids are resolved server-side in
// app/(app)/entries/page.tsx and passed down as props, so first paint carries
// this data instead of waiting on a post-mount fetch waterfall.
export function EntriesExplorer({
  initialOptions,
  initialRole,
  initialOwnDepartmentIds,
  typeCounts,
  statusCounts,
  hubStatusCounts,
}: {
  initialOptions: FilterOptions
  initialRole: StaffRole | null
  initialOwnDepartmentIds: number[]
  typeCounts: EntryStatusCount[]
  statusCounts: EntryStatusCount[]
  hubStatusCounts: EntryStatusCount[]
}) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [filters, setFilters] = useState<EntriesFilters>(() => searchParamsToFilters(searchParams))
  const [sort, setSort] = useState<EntriesSort>(() => searchParamsToSort(searchParams))
  const [options] = useState<FilterOptions>(initialOptions)
  const [role] = useState<StaffRole | null>(initialRole)
  // Empty = an all-departments account; the New-entry form then has to ask which department.
  const [ownDepartmentIds] = useState<number[]>(initialOwnDepartmentIds)

  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [pages, setPages] = useState<EntryEnriched[][]>([])
  const [hasMoreFlags, setHasMoreFlags] = useState<boolean[]>([])
  const [cursors, setCursors] = useState<PageCursor[]>([])
  const [pageIndex, setPageIndex] = useState(0)
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [allMatchingSelected, setAllMatchingSelected] = useState(false)
  const [selectingAll, setSelectingAll] = useState(false)
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(() => defaultVisibleColumns())
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false)
  const [bulkEnrichDialogOpen, setBulkEnrichDialogOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const requestIdRef = useRef(0)
  const isMountRef = useRef(true)
  const prevStateRef = useRef<{ filters: EntriesFilters; sort: EntriesSort }>({ filters, sort })
  const skipUrlWriteRef = useRef(false)
  const tableWrapRef = useRef<HTMLDivElement>(null)

  // §4.6: restore the persisted column choice on mount. Done in an effect
  // (not the useState initializer) so server and first client render agree on
  // the defaults, then converge to the stored set.
  useEffect(() => {
    const stored = loadStoredColumns()
    if (stored) setVisibleColumns(stored)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(Array.from(visibleColumns)))
    } catch {
      /* private mode / quota — the chooser still works for this session */
    }
  }, [visibleColumns])

  const loadFirstPage = useCallback(
    async (activeFilters: EntriesFilters, activeSort: EntriesSort, limit: number) => {
      const requestId = ++requestIdRef.current
      setLoading(true)
      setLoadError(null)
      try {
        const result = await fetchEntriesPage({
          supabase,
          filters: activeFilters,
          sort: activeSort,
          cursor: null,
          limit,
        })
        if (requestId !== requestIdRef.current) return // a newer request superseded this one
        setPages([result.rows])
        setHasMoreFlags([result.hasMore])
        setCursors([result.nextCursor])
        setPageIndex(0)
        setTotal(result.total)
        setSelected(new Set())
        setAllMatchingSelected(false)
      } catch (err) {
        if (requestId !== requestIdRef.current) return
        setLoadError(err instanceof Error ? err.message : 'Could not load entries.')
        setPages([])
        setHasMoreFlags([])
        setCursors([])
        setTotal(null)
      } finally {
        if (requestId === requestIdRef.current) setLoading(false)
      }
    },
    [supabase],
  )

  // ---- fetch page 1 whenever filters or sort change ----
  // §4.7 / §4.10: immediate on mount and on committed changes (selects, sort),
  // debounced only for later free-text vendor edits. URL write is `push` for
  // committed changes so Back/Forward work, `replace` for the debounced vendor
  // stream so it doesn't flood history.
  useEffect(() => {
    const prev = prevStateRef.current
    prevStateRef.current = { filters, sort }

    if (isMountRef.current) {
      isMountRef.current = false
      void loadFirstPage(filters, sort, pageSize)
      return
    }

    const vendorOnly = sortsEqual(prev.sort, sort) && onlyVendorChanged(prev.filters, filters)
    // The stale-rows-while-refetching dim treatment (§4.10) is only honest
    // when the row *set* is still valid -- a pure sort change re-orders the
    // same matches, so the old rows stay dimmed and visible. A filter change
    // (vendor included) makes the currently-shown rows a different, no-longer-
    // matching set; leaving them up (even dimmed) reads as "the table
    // unfiltered itself" for a beat before the real results land. Clear them
    // up front so a filter change goes to the empty-state skeleton instead.
    const filtersChanged = !filtersEqual(prev.filters, filters)

    const writeUrl = () => {
      if (skipUrlWriteRef.current) {
        skipUrlWriteRef.current = false
        return
      }
      const qs = serializeState(filters, sort)
      const href = qs ? `${pathname}?${qs}` : pathname
      if (vendorOnly) router.replace(href, { scroll: false })
      else router.push(href, { scroll: false })
    }

    if (vendorOnly) {
      const t = setTimeout(() => {
        writeUrl()
        if (filtersChanged) setPages([])
        void loadFirstPage(filters, sort, pageSize)
      }, 300)
      return () => clearTimeout(t)
    }

    writeUrl()
    if (filtersChanged) setPages([])
    void loadFirstPage(filters, sort, pageSize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, sort])

  // §4.7: resync state when the serialized URL diverges from it (Back/Forward,
  // or a link landing here pre-filtered). String compare, so a write we just
  // made is a no-op and there is no loop.
  useEffect(() => {
    const incoming = searchParams.toString()
    if (incoming === serializeState(filters, sort)) return
    skipUrlWriteRef.current = true // the fetch effect below will refetch; don't re-push
    setFilters(searchParamsToFilters(searchParams))
    setSort(searchParamsToSort(searchParams))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  async function goNext() {
    if (pageIndex + 1 < pages.length) {
      setPageIndex(pageIndex + 1)
      return
    }
    if (!hasMoreFlags[pageIndex]) return
    const cursor = cursors[pageIndex] ?? null
    setLoading(true)
    try {
      const result = await fetchEntriesPage({ supabase, filters, sort, cursor, limit: pageSize })
      setPages((prev) => [...prev, result.rows])
      setHasMoreFlags((prev) => [...prev, result.hasMore])
      setCursors((prev) => [...prev, result.nextCursor])
      setPageIndex(pageIndex + 1)
      if (result.total !== null) setTotal(result.total)
    } catch (err) {
      toastError(err instanceof Error ? err.message : null, { title: 'Could not load the next page.', context: 'entries-explorer' })
    } finally {
      setLoading(false)
    }
  }

  function goPrev() {
    if (pageIndex === 0) return
    setPageIndex(pageIndex - 1)
  }

  function handlePageSizeChange(size: number) {
    setPageSize(size)
    void loadFirstPage(filters, sort, size)
  }

  function handleFilterChange(next: Partial<EntriesFilters>) {
    setFilters((prev) => ({ ...prev, ...next }))
  }

  function clearAllFilters() {
    setFilters(DEFAULT_FILTERS)
  }

  function toggleColumn(key: ColumnKey) {
    setVisibleColumns((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        if (next.size === 1) return prev // §4.6: never hide the last column
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const currentRows = pages[pageIndex] ?? []

  function toggleRow(id: number) {
    setAllMatchingSelected(false)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllOnPage() {
    setAllMatchingSelected(false)
    setSelected((prev) => {
      const next = new Set(prev)
      const allSelected = currentRows.length > 0 && currentRows.every((r) => next.has(r.id))
      for (const row of currentRows) {
        if (allSelected) next.delete(row.id)
        else next.add(row.id)
      }
      return next
    })
  }

  function clearSelection() {
    setSelected(new Set())
    setAllMatchingSelected(false)
  }

  async function selectAllMatching() {
    setSelectingAll(true)
    try {
      const { ids, truncated } = await fetchAllMatchingIds(supabase, filters)
      setSelected(new Set(ids))
      setAllMatchingSelected(true)
      if (truncated) {
        toast.warning(
          `Selected the first ${ids.length.toLocaleString('en-IN')} entries — there are too many matches to select every one.`,
        )
      }
    } catch (err) {
      toastError(err instanceof Error ? err.message : null, {
        title: 'Could not select all matching entries.',
        context: 'entries-explorer',
      })
    } finally {
      setSelectingAll(false)
    }
  }

  async function handleExport() {
    setExporting(true)
    try {
      const { rowCount, truncated } = await exportEntriesToCsv(supabase, filters, visibleColumns)
      if (rowCount === 0) {
        toast.warning('No matching entries to export.')
      } else if (truncated) {
        toast.warning(`Exported the first ${rowCount.toLocaleString('en-IN')} entries — the match set was larger than the export limit.`)
      } else {
        toast.success(`Exported ${rowCount} ${rowCount === 1 ? 'entry' : 'entries'}.`)
      }
    } catch (err) {
      toastError(err instanceof Error ? err.message : null, { title: 'CSV export failed.', context: 'entries-explorer' })
    } finally {
      setExporting(false)
    }
  }

  function restoreTableFocus() {
    // §4.10: the bulk bar (which held the just-clicked trigger) unmounts when
    // the selection clears — move focus somewhere sensible instead of losing it.
    queueMicrotask(() => {
      tableWrapRef.current?.querySelector<HTMLAnchorElement>('a[href^="/entries/"]')?.focus()
    })
  }

  const canBulkEdit = isAdminOrAbove(role)
  const hasNoDepartments = options.departments.length === 0
  const adminView = isAdminOrAbove(role)
  const activeFilterCount = countActiveFilters(filters)

  const isFirstPage = pageIndex === 0
  const isLastPage = pageIndex === pages.length - 1 && !hasMoreFlags[pageIndex]
  const rangeStart = currentRows.length === 0 ? 0 : pageIndex * pageSize + 1
  const rangeEnd = currentRows.length === 0 ? -1 : pageIndex * pageSize + currentRows.length

  const wholePageSelected = currentRows.length > 0 && currentRows.every((r) => selected.has(r.id))
  const morePagesExist = Boolean(hasMoreFlags[pageIndex]) || pages.length > 1
  const showSelectAllMatching = wholePageSelected && morePagesExist && !allMatchingSelected
  const matchingLabel = total !== null ? total.toLocaleString('en-IN') : `${selected.size.toLocaleString('en-IN')}+`

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Entries</h1>
        <div className="flex flex-wrap items-center gap-2">
          {role !== null && (
            <NewEntryDialog
              departments={options.departments}
              budgetHeads={options.budgetHeads}
              ownDepartmentIds={ownDepartmentIds}
              onCreated={() => void loadFirstPage(filters, sort, pageSize)}
            />
          )}
          <ColumnChooser visible={visibleColumns} onToggle={toggleColumn} />
          <Button variant="outline" size="sm" className="gap-1.5" onClick={handleExport} disabled={exporting}>
            <Download className="h-3.5 w-3.5" />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
        </div>
      </div>

      {hasNoDepartments ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            {adminView ? (
              <>
                <p className="text-sm font-medium">This event has no departments mapped yet.</p>
                <p className="max-w-md text-sm text-muted-foreground">
                  Map departments to the selected event (or import ledger data for it) and its entries will appear here.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">You don&apos;t have access to any departments yet.</p>
                <p className="max-w-md text-sm text-muted-foreground">
                  Your account may still be pending activation, or has not been assigned a department. Ask an admin to
                  activate your account in <span className="font-mono">staff_profile</span>.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <FilterBar filters={filters} options={options} onChange={handleFilterChange} />

          <StatusCountChips
            typeCounts={typeCounts}
            statusCounts={statusCounts}
            hubStatusCounts={hubStatusCounts}
            activeType={filters.type}
            activeStatus={filters.status}
            activeHubStatus={filters.hubStatus}
            onSelectType={(id) => handleFilterChange({ type: id })}
            onSelectStatus={(id) => handleFilterChange({ status: id })}
            onSelectHubStatus={(id) => handleFilterChange({ hubStatus: id })}
          />

          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-accent/40 px-3 py-2 text-sm">
              <span>
                {allMatchingSelected
                  ? `All ${selected.size.toLocaleString('en-IN')} selected`
                  : `${selected.size.toLocaleString('en-IN')} selected`}
              </span>
              {showSelectAllMatching && (
                <Button variant="outline" size="sm" onClick={selectAllMatching} disabled={selectingAll}>
                  {selectingAll ? 'Selecting…' : `Select all ${matchingLabel} matching these filters`}
                </Button>
              )}
              {canBulkEdit ? (
                <>
                  <Button size="sm" className="gap-1.5" onClick={() => setBulkDialogOpen(true)}>
                    <Tag className="h-3.5 w-3.5" />
                    Set Hub status…
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => setBulkEnrichDialogOpen(true)}
                  >
                    <Building2 className="h-3.5 w-3.5" />
                    Assign zone / head…
                  </Button>
                </>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Your role can view but not change Hub status or enrichment fields.
                </span>
              )}
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                Clear selection
              </Button>
            </div>
          )}

          {loadError ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <p className="text-sm font-medium text-destructive">Could not load entries.</p>
                <FriendlyError message={loadError} className="max-w-md" />
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => loadFirstPage(filters, sort, pageSize)}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              <div ref={tableWrapRef}>
                <EntriesTable
                  rows={currentRows}
                  visibleColumns={visibleColumns}
                  loading={loading && currentRows.length === 0}
                  refetching={loading && currentRows.length > 0}
                  activeFilterCount={activeFilterCount}
                  onClearFilters={clearAllFilters}
                  selected={selected}
                  onToggleRow={toggleRow}
                  onToggleAll={toggleAllOnPage}
                  sort={sort}
                  onSortChange={setSort}
                />
              </div>

              {!(loading && currentRows.length === 0) && (
                <PaginationBar
                  rangeStart={rangeStart}
                  rangeEnd={rangeEnd}
                  total={total}
                  pageSize={pageSize}
                  onPageSizeChange={handlePageSizeChange}
                  canPrev={!isFirstPage}
                  canNext={!isLastPage}
                  onPrev={goPrev}
                  onNext={() => void goNext()}
                  disabled={loading}
                  noun="entry"
                />
              )}
            </>
          )}
        </>
      )}

      <BulkStatusDialog
        open={bulkDialogOpen}
        onOpenChange={setBulkDialogOpen}
        entryIds={Array.from(selected)}
        hubStatuses={options.hubStatuses}
        onDone={() => {
          clearSelection()
          restoreTableFocus()
          void loadFirstPage(filters, sort, pageSize)
        }}
      />

      <BulkEnrichmentDialog
        open={bulkEnrichDialogOpen}
        onOpenChange={setBulkEnrichDialogOpen}
        entryIds={Array.from(selected)}
        adminHeadOptions={options.adminHeads}
        zoneOptions={options.zones}
        costCenterOptions={options.costCenters}
        onDone={() => {
          clearSelection()
          restoreTableFocus()
          void loadFirstPage(filters, sort, pageSize)
        }}
      />
    </div>
  )
}
