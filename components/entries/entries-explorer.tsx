'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Download, RotateCcw, Tag } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { FilterBar } from './filter-bar'
import { ColumnChooser } from './column-chooser'
import { EntriesTable } from './entries-table'
import { BulkStatusDialog } from './bulk-status-dialog'
import { exportEntriesToCsv } from './csv-export'
import { fetchEntriesPage } from './query'
import { ALL_COLUMNS, PAGE_SIZE } from './types'
import type { ColumnKey, EntriesFilters, EntryEnriched, FilterOptions } from './types'

const EMPTY_OPTIONS: FilterOptions = {
  departments: [],
  budgetHeads: [],
  adminHeads: [],
  zones: [],
  budgetCategories: [],
  statuses: [],
  auditStatuses: [],
  hubStatuses: [],
}

function filtersToSearchParams(filters: EntriesFilters): URLSearchParams {
  const sp = new URLSearchParams()
  if (filters.department) sp.set('dept', filters.department)
  if (filters.budgetHead) sp.set('bh', filters.budgetHead)
  if (filters.adminHead) sp.set('ahead', filters.adminHead)
  if (filters.zone) sp.set('zone', filters.zone)
  if (filters.budgetCategory) sp.set('bcat', filters.budgetCategory)
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
    budgetCategory: sp.get('bcat') ?? '',
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

export function EntriesExplorer() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [filters, setFilters] = useState<EntriesFilters>(() => searchParamsToFilters(searchParams))
  const [options, setOptions] = useState<FilterOptions>(EMPTY_OPTIONS)
  const [optionsLoaded, setOptionsLoaded] = useState(false)
  const [role, setRole] = useState<'admin' | 'reviewer' | 'viewer' | null>(null)

  const [pages, setPages] = useState<EntryEnriched[][]>([])
  const [hasMoreFlags, setHasMoreFlags] = useState<boolean[]>([])
  const [pageIndex, setPageIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(
    () => new Set(ALL_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key))
  )
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)

  // ---- filter options + own role (once) --------------------------------
  useEffect(() => {
    let cancelled = false
    async function loadOptions() {
      const [dept, bh, adminHead, zone, budgetCategory, status, hub, userRes] = await Promise.all([
        supabase.from('department').select('id,name').eq('is_active', true).order('name'),
        supabase.from('budget_head').select('id,raw_label,short_label,department_id').order('raw_label'),
        supabase.from('admin_head').select('id,name,head_number,department_id').eq('is_active', true).order('head_number'),
        supabase.from('zone').select('id,name,zone_number,department_id').eq('is_active', true).order('zone_number'),
        supabase.from('budget_category').select('id,name').order('name'),
        supabase.from('entry_status').select('id,code,label,source_system').order('sort_order'),
        supabase.from('hub_status').select('id,code,label').order('sort_order'),
        supabase.auth.getUser(),
      ])
      if (cancelled) return

      const nextOptions: FilterOptions = {
        departments: (dept.data ?? []).map((d) => ({ id: d.id, label: d.name })),
        budgetHeads: (bh.data ?? []).map((b) => ({
          id: b.id,
          label: b.short_label ?? b.raw_label,
          department_id: b.department_id,
        })),
        adminHeads: (adminHead.data ?? []).map((h) => ({ id: h.id, label: `${h.head_number}. ${h.name}`, department_id: h.department_id })),
        zones: (zone.data ?? []).map((z) => ({ id: z.id, label: `${z.zone_number}. ${z.name}`, department_id: z.department_id })),
        budgetCategories: (budgetCategory.data ?? []).map((c) => ({ id: c.id, label: c.name })),
        statuses: (status.data ?? [])
          .filter((s) => s.source_system === 'departmental')
          .map((s) => ({ id: s.id, label: s.label, code: s.code })),
        auditStatuses: (status.data ?? [])
          .filter((s) => s.source_system === 'audit')
          .map((s) => ({ id: s.id, label: s.label, code: s.code })),
        hubStatuses: (hub.data ?? []).map((h) => ({ id: h.id, label: h.label, code: h.code })),
      }
      setOptions(nextOptions)
      setOptionsLoaded(true)

      const user = userRes.data.user
      if (user) {
        const { data: profile } = await supabase.from('staff_profile').select('role').eq('id', user.id).maybeSingle()
        if (!cancelled) setRole((profile?.role as typeof role) ?? null)
      }
    }
    loadOptions().catch((err) => {
      console.error('[entries] failed to load filter options', err)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- fetch page 1 whenever filters change, debounced + URL-synced ----
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const sp = filtersToSearchParams(filters)
      const qs = sp.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
      void loadFirstPage(filters)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters])

  const loadFirstPage = useCallback(
    async (activeFilters: EntriesFilters) => {
      const requestId = ++requestIdRef.current
      setLoading(true)
      setLoadError(null)
      try {
        const result = await fetchEntriesPage({ supabase, filters: activeFilters, cursor: null, limit: PAGE_SIZE })
        if (requestId !== requestIdRef.current) return // a newer request superseded this one
        setPages([result.rows])
        setHasMoreFlags([result.hasMore])
        setPageIndex(0)
        setSelected(new Set())
      } catch (err) {
        if (requestId !== requestIdRef.current) return
        setLoadError(err instanceof Error ? err.message : 'Could not load entries.')
        setPages([])
        setHasMoreFlags([])
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
    const currentRows = pages[pageIndex] ?? []
    const lastRow = currentRows[currentRows.length - 1]
    if (!lastRow) return
    setLoading(true)
    try {
      const result = await fetchEntriesPage({ supabase, filters, cursor: lastRow.id, limit: PAGE_SIZE })
      setPages((prev) => [...prev, result.rows])
      setHasMoreFlags((prev) => [...prev, result.hasMore])
      setPageIndex(pageIndex + 1)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the next page.')
    } finally {
      setLoading(false)
    }
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
      toast.error(err instanceof Error ? err.message : 'CSV export failed.')
    } finally {
      setExporting(false)
    }
  }

  const canBulkEdit = role === 'admin' || role === 'reviewer'
  const noDepartmentAccess = optionsLoaded && options.departments.length === 0
  const isFirstPage = pageIndex === 0
  const isLastPage = pageIndex === pages.length - 1 && !hasMoreFlags[pageIndex]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Entries</h1>
        <div className="flex items-center gap-2">
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
            <div className="flex items-center gap-3 rounded-lg border border-border bg-accent/40 px-3 py-2 text-sm">
              <span>
                {selected.size} selected
              </span>
              {canBulkEdit ? (
                <Button size="sm" className="gap-1.5" onClick={() => setBulkDialogOpen(true)}>
                  <Tag className="h-3.5 w-3.5" />
                  Set Hub status…
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">Your role can view but not change Hub status.</span>
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
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => loadFirstPage(filters)}>
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
          void loadFirstPage(filters)
        }}
      />
    </div>
  )
}
