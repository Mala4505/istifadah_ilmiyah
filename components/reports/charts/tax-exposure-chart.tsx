'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { formatINR, formatINRCompact, formatPercent } from '@/lib/reports/format'
import { barWidthClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md B-08 (flagship): "Tax charged, against the share of
// it where the vendor GSTIN passes checksum and our own GSTIN appears on the
// bill. The gap is credit that may not be claimable." One stacked bar per
// department: claimable ₹ fills first (a plain series blue — this is the
// "fine" state, no status meaning needed), then ₹ at risk in the reserved
// red status colour WITH its own legend label (§6 fix #5: status colour, not
// a plain series hue, and never unlabelled). A single money scale only —
// each department's outer bar is sized by its own total tax charged, relative
// to the largest department's total, so the *absolute* rupee gap reads
// directly off bar length; the inner claimable/at-risk split is the
// department's own share, not renormalised against the other departments
// (never two scales on one chart, §6 fix #8).
//
// Structurally mirrors instrument-mix-chart.tsx: plain HTML segmented divs
// sized with literal `barWidthClass` build-time Tailwind classes, never a
// data-driven inline style (this app's production style-src CSP — see
// lib/reports/bar-scale.ts's header), plus a required "View as table" twin.

/** Floor so a department with real but tiny tax charged still renders a
 *  visible sliver instead of snapping to 0 width (barWidthClass snaps to the
 *  nearest 5%). */
const MIN_VISIBLE_PCT = 3

export type TaxExposureDept = {
  key: number | string
  name: string
  claimable: number
  atRisk: number
  total: number
}

export function TaxExposureChart({ departments }: { departments: TaxExposureDept[] }) {
  const [showTable, setShowTable] = useState(false)
  const [hover, setHover] = useState<{ deptKey: string; segment: 'claimable' | 'atRisk' } | null>(null)

  const rows = departments.filter((d) => d.total > 0).sort((a, b) => b.total - a.total)
  if (rows.length === 0) return null

  const maxTotal = Math.max(...rows.map((d) => d.total))

  const tableColumns: DataTableColumn<TaxExposureDept>[] = [
    { key: 'dept', header: 'Department', render: (d) => d.name },
    { key: 'claimable', header: 'Claimable ₹', align: 'right', render: (d) => formatINR(d.claimable) },
    { key: 'atrisk', header: '₹ at risk', align: 'right', render: (d) => formatINR(d.atRisk) },
    { key: 'total', header: 'Total tax charged', align: 'right', render: (d) => formatINR(d.total) },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex flex-col gap-2.5"
        role="img"
        aria-label="Tax credit exposure by department — claimable input tax credit against the share sitting on a bill with an open GSTIN or recipient-compliance exception, each department's bar scaled by its own total tax charged. See the table view below for exact rupee figures."
        onPointerLeave={() => setHover(null)}
      >
        {rows.map((d) => {
          const pctOfMax = Math.max(MIN_VISIBLE_PCT, (d.total / maxTotal) * 100)
          const atRiskPct = d.total > 0 ? (d.atRisk / d.total) * 100 : 0
          const key = String(d.key)
          const active = hover?.deptKey === key ? hover.segment : null
          return (
            <div key={d.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="truncate text-foreground">{d.name}</span>
                <span className="shrink-0 font-mono text-muted-foreground">
                  {active === 'atRisk'
                    ? `At risk: ${formatINRCompact(d.atRisk)} · ${formatPercent(atRiskPct)}`
                    : active === 'claimable'
                      ? `Claimable: ${formatINRCompact(d.claimable)}`
                      : `${formatINRCompact(d.total)} tax charged`}
                </span>
              </div>
              <div className={cn('h-4 rounded-sm bg-secondary/30', barWidthClass(pctOfMax))}>
                <div className="flex h-full w-full gap-[2px] overflow-hidden rounded-sm">
                  {d.claimable > 0 && (
                    <div
                      className="h-full flex-1 bg-[#2a78d6] dark:bg-[#3987e5]"
                      title={`${d.name} · Claimable: ${formatINR(d.claimable)}`}
                      onPointerEnter={() => setHover({ deptKey: key, segment: 'claimable' })}
                    />
                  )}
                  {d.atRisk > 0 && (
                    <div
                      className={cn('h-full bg-red-600 dark:bg-red-500', barWidthClass(atRiskPct))}
                      title={`${d.name} · At risk: ${formatINR(d.atRisk)} (${formatPercent(atRiskPct)})`}
                      onPointerEnter={() => setHover({ deptKey: key, segment: 'atRisk' })}
                    />
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-[#2a78d6] dark:bg-[#3987e5]" />
          Claimable
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-red-600 dark:bg-red-500" />
          At risk — open GSTIN checksum or recipient-compliance exception
        </span>
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={rows} getRowKey={(d) => d.key} />}
    </div>
  )
}
