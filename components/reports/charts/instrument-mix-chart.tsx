'use client'

import { useState } from 'react'
import { formatINR } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import { StackedDepartmentBars, type StackedRow, type StackedSeries } from './stacked-department-bars'

// reporting-blueprint.md C-09 (flagship) §4: "Stacked bar per department, split
// by document kind, measured in rupees not counts." Turns a compliance question
// into a money question. The eleven instrument-type codes collapse to five
// ordered tiers of backing strength (best → worst); colour follows that fixed
// order using this screen's blue ordinal ramp (charts/ordinal-ramp.ts — a real
// quality gradient, so the best-backed tier is the darkest, most solid step),
// with "no supporting bill" rendered as a neutral absence rather than another
// blue. Each department's bar is 100%-stacked so the *mix* is comparable across
// departments of very different size; the absolute rupee figures live in the
// tooltip, the KPI, the sentence and the table twin.
//
// shadcn chart (Recharts 3) via stacked-department-bars.tsx: 2px surface gaps
// between segments, legend always present, "View as table" twin carries every
// rupee figure (dataviz skill).

/** Fixed best-to-worst order. Keys are also used by the section's grouping. */
const GROUP_KEYS = ['tax_invoice', 'bill_of_supply', 'other_bill', 'unclassified', 'no_document'] as const
type GroupKey = (typeof GROUP_KEYS)[number]

const SERIES: readonly StackedSeries[] = [
  { key: 'tax_invoice', label: 'Tax invoice', theme: { light: '#184f95', dark: '#184f95' } },
  { key: 'bill_of_supply', label: 'Bill of supply', theme: { light: '#2a78d6', dark: '#256abf' } },
  { key: 'other_bill', label: 'Other bill', theme: { light: '#5598e7', dark: '#3987e5' } },
  { key: 'unclassified', label: 'Not yet classified', theme: { light: '#86b6ef', dark: '#6da7ec' } },
  // muted-foreground at 40% over the card surface — a neutral "absence" step.
  { key: 'no_document', label: 'No supporting bill', theme: { light: '#c7c4c1', dark: '#59514f' } },
]

const LABELS = Object.fromEntries(SERIES.map((s) => [s.key, s.label])) as Record<GroupKey, string>

export type InstrumentMixDept = {
  key: number | string
  name: string
  total: number
  /** Rupees per group key (see GROUP_KEYS). Missing keys read as 0. */
  values: Record<string, number>
}

export function InstrumentMixChart({
  departments,
  tableTwin = true,
}: {
  departments: InstrumentMixDept[]
  /** false when the host section already renders the same rows as a table
   *  (with drill links) directly below — avoids showing it twice. */
  tableTwin?: boolean
}) {
  const [showTable, setShowTable] = useState(false)

  if (departments.length === 0) return null

  const rows = departments.filter((d) => d.total > 0).sort((a, b) => b.total - a.total)
  if (rows.length === 0) return null

  const stackedRows: StackedRow[] = rows.map((d) => ({
    rowKey: String(d.key),
    label: d.name,
    total: d.total,
    values: d.values,
  }))

  const tableColumns: DataTableColumn<InstrumentMixDept>[] = [
    { key: 'dept', header: 'Department', render: (d) => d.name },
    ...GROUP_KEYS.map(
      (gk): DataTableColumn<InstrumentMixDept> => ({
        key: gk,
        header: LABELS[gk],
        align: 'right',
        render: (d) => ((d.values[gk] ?? 0) > 0 ? formatINR(d.values[gk] ?? 0) : '—'),
      })
    ),
    { key: 'total', header: 'Total', align: 'right', render: (d) => formatINR(d.total) },
  ]

  return (
    <div className="flex flex-col gap-3">
      <StackedDepartmentBars
        rows={stackedRows}
        series={SERIES}
        mode="percent"
        ariaLabel="Instrument-type mix — each department's spend split by the kind of bill backing it, best-backed first. See the table view below for exact rupee figures."
      />

      {tableTwin && (
        <>
          <div>
            <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'Hide table' : 'View as table'}
            </Button>
          </div>
          {showTable && <DataTable columns={tableColumns} rows={rows} getRowKey={(d) => d.key} />}
        </>
      )}
    </div>
  )
}
