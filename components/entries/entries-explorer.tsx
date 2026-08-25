'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Building2, Download, RotateCcw, Tag } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { FilterBar } from './filter-bar'
import { ColumnChooser } from './column-chooser'
import { EntriesTable } from './entries-table'
import { BulkStatusDialog } from './bulk-status-dialog'
import { BulkEnrichmentDialog } from './bulk-enrichment-dialog'
import { exportEntriesToCsv } from './csv-export'
import { fetchEntriesPage, type PageCursor } from './query'
import { ALL_COLUMNS, DEFAULT_SORT, PAGE_SIZE } from './types'
import type { ColumnKey, EntriesFilters, EntriesSort, EntryEnriched, FilterOptions, SortColumn, SortDirection } from './types'
import { NewEntryDialog } from './new-entry-dialog'
import { isAdminOrAbove, type StaffRole } from '@/lib/auth/roles'

function filtersToSearchParams(filters: EntriesFilters): URLSearchParams {
  const sp = new URLSearchParams()
  if (filters.department) sp.set('dept', filters.department)
  if (filters.budgetHead) sp.set('bh', filters.budgetHead)
  if (filters.adminHead) sp.set('ahead', filters.adminHead)
  if (filters.zone) sp.set('zone', filters.zone)
  if (filters.costCenter) sp.set('cc', filters.costCenter)
  if (filters.status) sp.set('st', filters.status)
  if (filters.auditStatus) sp.set('ast', filters.auditStatus)
  if (filters.hubStatus) sp.set('hs', filters.hubStatus)
  if (filters.exportPending) sp.set('exp', '1')
  if (filters.dateFrom) sp.set('from', filters.dateFrom)
  if (filters.dateTo) sp.set('to', filters.dateTo)
  if (filters.vendor) sp.set('vendor', filters.vendor)
  if (filters.hasVariance) sp.set('var', '1')
  if (filters.hasDocument) sp.set('doc', '1')
  return sp
}

function searchParamsToFilters(sp: URLSearchParams): EntriesFilters {
  return {
    department: sp.get('dept') ?? '',
    budgetHead: sp.get('bh') ?? '',
    adminHead: sp.get('ahead') ?? '',
    zone: sp.get('zone') ?? '',
    costCenter: sp.get('cc') ?? '',
    status: sp.get('st') ?? '',
    auditStatus: sp.get('ast') ?? '',
    hubStatus: sp.get('hs') ?? '',
    exportPending: sp.get('exp') === '1',
    dateFrom: sp.get('from') ?? '',
    dateTo: sp.get('to') ?? '',
    vendor: sp.get('vendor') ?? '',
    hasVariance: sp.get('var') === '1',
    hasDocument: sp.get('doc') === '1',
  }
}

// Sort state gets the same URL-sync treatment as filters (hub-refinements-plan.md
// §1/§2): "a sorted view stays copy-pasteable." Only written to the URL when it
// differs from the default, so the common case (id desc, unsorted) doesn't clutter
// every entries-list link with `?sort=id&dir=desc`.
const SORT_COLUMNS: SortColumn[] = [
  'id',
  'amount',
  'date',
  'vendor_display_name',
  'status_label',
  'ubbl_number',
  'main_number',
  'budget_head_short_label',
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

// Phase 5 §8.1 (docs/pre-deploy-findings-and-plan.md): the filter-dropdown
// lookups (departments, budget heads, admin heads, zones, cost centers,
// statuses, hub statuses) and the viewer's own role/department-ids used to
// be fetched here in a client-side useEffect chain that fired after mount --
// several sequential/parallel round trips gating first paint, and the
// biggest single contributor to Entries being the slowest screen in the app
// (3.7s to settle at 14 entries). app/(app)/entries/page.tsx now resolves
// all of it server-side (same event-membership-scoped logic, moved
// verbatim) and passes it down as props, so first paint carries this data
// instead of waiting on it. Seeded into state once via useState's
// lazy-initializer form is intentional, not a bug: page.tsx is the sole
// caller (verified via grep — no other importer), it always fully remounts
// this component on navigation to /entries, and in-page filter/sort changes
// never change these props, so there is nothing to resync against.
export function EntriesExplorer({
  initialOptions,
  initialRole,
  initialOwnDepartmentIds,
}: {
  initialOptions: FilterOptions
  initialRole: StaffRole | null
  initialOwnDepartmentIds: number[]
}) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [filters, setFilters] = useState<EntriesFilters>(() => searchParamsToFilters(searchParams))
  const [sort, setSort] = useState<EntriesSort>(() => searchParamsToSort(searchParams))
  const [options] = useState<FilterOptions>(initialOptions)
  const optionsLoaded = true
  const [role] = useState<StaffRole | null>(initialRole)
  // Empty = an all-departments account; the New-entry form then has to ask which department.
  const [ownDepartmentIds] = useState<number[]>(initialOwnDepartmentIds)

  const [pages, setPages] = useState<EntryEnriched[][]>([])
  const [hasMoreFlags, setHasMoreFlags] = useState<boolean[]>([])
  const [cursors, setCursors] = useState<PageCursor[]>([])
  const [pageIndex, setPageIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(
    () => new Set(ALL_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key))
  )
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false)
  const [bulkEnrichDialogOpen, setBulkEnrichDialogOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)

  // ---- fetch page 1 whenever filters or sort change, debounced + URL-synced ----
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const sp = filtersToSearchParams(filters)
      for (const [key, value] of sortToSearchParams(sort)) sp.set(key, value)
      const qs = sp.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
      void loadFirstPage(filters, sort)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, sort])

  const loadFirstPage = useCallback(
    async (activeFilters: EntriesFilters, activeSort: EntriesSort) => {
      const requestId = ++requestIdRef.current
      setLoading(true)
      setLoadError(null)
      try {
        const result = await fetchEntriesPage({
          supabase,
          filters: activeFilters,
          sort: activeSort,
          cursor: null,
          limit: PAGE_SIZE,
        })
        if (requestId !== requestIdRef.current) return // a newer request superseded this one
        setPages([result.rows])
        setHasMoreFlags([result.hasMore])
        setCursors([result.nextCursor])
        setPageIndex(0)
        setSelected(new Set())
      } catch (err) {
        if (requestId !== requestIdRef.current) return
        setLoadError(err instanceof Error ? err.message : 'Could not load entries.')
        setPages([])
        setHasMoreFlags([])
        setCursors([])
      } finally {
        if (requestId === requestIdRef.current) setLoading(false)
      }
    },
    [supabase]
  )

  async function goNext() {
    if (pageIndex + 1 < pages.length) {
      setPageIndex(pageIndex + 1)
      return
    }
    if (!hasMoreFlags[pageIndex]) return
    const cursor = cursors[pageIndex] ?? null
    setLoading(true)
    try {
      const result = await fetchEntriesPage({ supabase, filters, sort, cursor, limit: PAGE_SIZE })
      setPages((prev) => [...prev, result.rows])
      setHasMoreFlags((prev) => [...prev, result.hasMore])
      setCursors((prev) => [...prev, result.nextCursor])
      setPageIndex(pageIndex + 1)
    } catch (err) {
      toastError(err instanceof Error ? err.message : null, { title: 'Could not load the next page.', context: 'entries-explorer' })
    } finally {
      setLoading(false)
    }
  }

  function handleSortChange(column: SortColumn) {
    setSort((prev) => {
      if (prev.column === column) {
        return { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
      }
      return { column, direction: 'asc' }
    })
  }

  function goPrev() {
    if (pageIndex === 0) return
    setPageIndex(pageIndex - 1)
  }

  function handleFilterChange(next: Partial<EntriesFilters>) {
    setFilters((prev) => ({ ...prev, ...next }))
  }

  function toggleColumn(key: ColumnKey) {
    setVisibleColumns((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const currentRows = pages[pageIndex] ?? []

  function toggleRow(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllOnPage() {
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

  async function handleExport() {
    setExporting(true)
    try {
      const { rowCount } = await exportEntriesToCsv(supabase, filters)
      if (rowCount === 0) {
        toast.warning('No matching entries to export.')
      } else {
        toast.success(`Exported ${rowCount} ${rowCount === 1 ? 'entry' : 'entries'}.`)
      }
    } catch (err) {
      toastError(err instanceof Error ? err.message : null, { title: 'CSV export failed.', context: 'entries-explorer' })
    } finally {
      setExporting(false)
    }
  }

  const canBulkEdit = isAdminOrAbove(role)
  const noDepartmentAccess = optionsLoaded && options.departments.length === 0
  const isFirstPage = pageIndex === 0
  const isLastPage = pageIndex === pages.length - 1 && !hasMoreFlags[pageIndex]

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Entries</h1>
        <div className="flex flex-wrap items-center gap-2">
          {/* Typing an entry is a dept/admin/superadmin action (entries_insert,
              20260819000002/20260819000003 — is_staff() gated, department-scoped
              via can_see_department) — dept keeps entry creation under the new
              model, so this only needs a loaded, non-null role rather than
              isAdminOrAbove. */}
          {role !== null && (
            <NewEntryDialog
              departments={options.departments}
              budgetHeads={options.budgetHeads}
              ownDepartmentIds={ownDepartmentIds}
              onCreated={() => void loadFirstPage(filters, sort)}
            />
          )}
          <ColumnChooser visible={visibleColumns} onToggle={toggleColumn} />
          <Button variant="outline" size="sm" className="gap-1.5" onClick={handleExport} disabled={exporting}>
            <Download className="h-3.5 w-3.5" />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
        </div>
      </div>

      {noDepartmentAccess ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <p className="text-sm font-medium">You don&apos;t have access to any departments yet.</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Your account may still be pending activation, or has not been assigned a department. Ask an admin to
              activate your account in <span className="font-mono">staff_profile</span>.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <FilterBar filters={filters} options={options} onChange={handleFilterChange} />

          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-accent/40 px-3 py-2 text-sm">
              <span>
                {selected.size} selected
              </span>
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
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            </div>
          )}

          {loadError ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <p className="text-sm font-medium text-destructive">Could not load entries.</p>
                <p className="max-w-md text-sm text-muted-foreground">{loadError}</p>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => loadFirstPage(filters, sort)}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              <EntriesTable
                rows={currentRows}
                visibleColumns={visibleColumns}
                loading={loading && currentRows.length === 0}
                selected={selected}
                onToggleRow={toggleRow}
                onToggleAll={toggleAllOnPage}
                sort={sort}
                onSortChange={handleSortChange}
              />

              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Page {pageIndex + 1}
                  {currentRows.length > 0 ? ` · ${currentRows.length} rows` : ''}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={goPrev} disabled={isFirstPage || loading}>
                    Previous
                  </Button>
                  <Button variant="outline" size="sm" onClick={goNext} disabled={isLastPage || loading}>
                    Next
                  </Button>
                </div>
              </div>
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
          setSelected(new Set())
          void loadFirstPage(filters, sort)
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
          setSelected(new Set())
          void loadFirstPage(filters, sort)
        }}
      />
    </div>
  )
}
