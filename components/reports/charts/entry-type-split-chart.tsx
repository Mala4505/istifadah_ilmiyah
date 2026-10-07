'use client'

import { useState } from 'react'
import { formatINR } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import { StackedDepartmentBars, type StackedRow, type StackedSeries } from './stacked-department-bars'
import { STATUS_WARN } from './recharts-kit'

// reporting-blueprint.md A-08 §5: "Invoice vs reimbursement vs advance vs
// invoice-against-uplaq, per department. A high reimbursement share is a
// control signal." Stacked bar per department, 100%-stacked so the *mix* is
// comparable across departments of very different size; the absolute rupee
// figures live in the tooltip, the KPI, the sentence and the table twin.
//
// Colour (dataviz skill / §6 fix #5): reimbursement is the control signal, so
// it takes the reserved warn hue (amber) with a legend label; the other three
// types are neutral spend and take steps of this screen's blue ordinal ramp
// (charts/ordinal-ramp.ts) in a fixed order. Never a generated/cycled hue.
//
// shadcn chart (Recharts 3) via stacked-department-bars.tsx. Drill-through is
// kept: the department name links to /entries?dept=.., and each segment
// clicks through to /entries?dept=..&tp=<type>.
//
// This is a 'use client' module: it imports NO runtime value from
// lib/reports/surfaces/entry-type-flow.ts (which pulls in next/headers via the
// server Supabase client). The section owns the raw-code -> ₹ mapping; this
// chart owns the key order, labels and colours. The four codes below are the
// entries_type_check values (20260828000002) -- keep in sync if that changes.

const SPLIT_KEYS = ['invoice', 'invoice_against_uplaq', 'advance_payment', 'reimbursement'] as const
type SplitKey = (typeof SPLIT_KEYS)[number]

const SERIES: readonly StackedSeries[] = [
  { key: 'invoice', label: 'Invoice', theme: { light: '#184f95', dark: '#184f95' } },
  { key: 'invoice_against_uplaq', label: 'Invoice against uplaq', theme: { light: '#2a78d6', dark: '#256abf' } },
  { key: 'advance_payment', label: 'Advance', theme: { light: '#86b6ef', dark: '#6da7ec' } },
  { key: 'reimbursement', label: 'Reimbursement (control signal)', theme: STATUS_WARN },
]

const LABELS = Object.fromEntries(SERIES.map((s) => [s.key, s.label])) as Record<SplitKey, string>

export type EntryTypeSplitDept = {
  key: number | string
  /** department_id, or null for the no-department bucket. */
  departmentId: number | null
  name: string
  total: number
  /** Rupees per raw entries.type code. Missing keys read as 0. */
  values: Record<string, number>
}

function deptHref(departmentId: number | null, code?: string): string | null {
  if (departmentId == null) return null
  const base = `/entries?dept=${departmentId}`
  return code ? `${base}&tp=${code}` : base
}

export function EntryTypeSplitChart({ departments }: { departments: EntryTypeSplitDept[] }) {
  const [showTable, setShowTable] = useState(false)

  const rows = departments.filter((d) => d.total > 0).sort((a, b) => b.total - a.total)
  if (rows.length === 0) return null

  const deptByRowKey = new Map(rows.map((d) => [String(d.key), d]))
  const stackedRows: StackedRow[] = rows.map((d) => ({
    rowKey: String(d.key),
    label: d.name,
    href: deptHref(d.departmentId),
    total: d.total,
    values: d.values,
  }))

  const tableColumns: DataTableColumn<EntryTypeSplitDept>[] = [
    { key: 'dept', header: 'Department', render: (d) => d.name },
    ...SPLIT_KEYS.map(
      (k): DataTableColumn<EntryTypeSplitDept> => ({
        key: k,
        header: LABELS[k],
        align: 'right',
        render: (d) => ((d.values[k] ?? 0) > 0 ? formatINR(d.values[k] ?? 0) : '—'),
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
        ariaLabel="Entry-type split — each department's spend split by entry type (invoice, invoice against uplaq, advance, reimbursement), measured in rupees. See the table view below for exact figures."
        segmentHref={(row, code) => deptHref(deptByRowKey.get(row.rowKey)?.departmentId ?? null, code)}
      />

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={rows} getRowKey={(d) => d.key} />}
    </div>
  )
}
