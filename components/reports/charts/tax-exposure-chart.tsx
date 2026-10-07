'use client'

import { useState } from 'react'
import { formatINR } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import { StackedDepartmentBars, type StackedRow, type StackedSeries } from './stacked-department-bars'
import { SERIES_BLUE, STATUS_CRITICAL } from './recharts-kit'

// reporting-blueprint.md B-08 (flagship): "Tax charged, against the share of
// it where the vendor GSTIN passes checksum and our own GSTIN appears on the
// bill. The gap is credit that may not be claimable." One stacked bar per
// department: claimable ₹ fills first (a plain series blue — this is the
// "fine" state, no status meaning needed), then ₹ at risk in the reserved
// red status colour WITH its own legend label (§6 fix #5: status colour, not
// a plain series hue, and never unlabelled). A single absolute ₹ axis — bar
// length is the department's total tax charged, so the *absolute* rupee gap
// reads directly off the chart (never two scales on one chart, §6 fix #8).
//
// shadcn chart (Recharts 3) via stacked-department-bars.tsx, plus a required
// "View as table" twin.

const SERIES: readonly StackedSeries[] = [
  { key: 'claimable', label: 'Claimable', theme: SERIES_BLUE },
  { key: 'atRisk', label: 'At risk — open GSTIN checksum or recipient-compliance exception', theme: STATUS_CRITICAL },
]

export type TaxExposureDept = {
  key: number | string
  name: string
  claimable: number
  atRisk: number
  total: number
}

export function TaxExposureChart({ departments }: { departments: TaxExposureDept[] }) {
  const [showTable, setShowTable] = useState(false)

  const rows = departments.filter((d) => d.total > 0).sort((a, b) => b.total - a.total)
  if (rows.length === 0) return null

  const stackedRows: StackedRow[] = rows.map((d) => ({
    rowKey: String(d.key),
    label: d.name,
    total: d.total,
    values: { claimable: d.claimable, atRisk: d.atRisk },
  }))

  const tableColumns: DataTableColumn<TaxExposureDept>[] = [
    { key: 'dept', header: 'Department', render: (d) => d.name },
    { key: 'claimable', header: 'Claimable ₹', align: 'right', render: (d) => formatINR(d.claimable) },
    { key: 'atrisk', header: '₹ at risk', align: 'right', render: (d) => formatINR(d.atRisk) },
    { key: 'total', header: 'Total tax charged', align: 'right', render: (d) => formatINR(d.total) },
  ]

  return (
    <div className="flex flex-col gap-3">
      <StackedDepartmentBars
        rows={stackedRows}
        series={SERIES}
        mode="absolute"
        ariaLabel="Tax credit exposure by department — claimable input tax credit against the share sitting on a bill with an open GSTIN or recipient-compliance exception, each department's bar as long as its total tax charged. See the table view below for exact rupee figures."
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
