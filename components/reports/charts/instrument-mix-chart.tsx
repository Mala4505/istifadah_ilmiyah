'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { formatINR, formatINRCompact, formatPercent } from '@/lib/reports/format'
import { barWidthClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md C-09 (flagship) §4: "Stacked bar per department, split
// by document kind, measured in rupees not counts." Turns a compliance question
// into a money question. The eleven instrument-type codes collapse to five
// ordered tiers of backing strength (best → worst); colour follows that fixed
// order using this screen's blue ordinal ramp (charts/ordinal-ramp.ts — a real
// quality gradient, so the best-backed tier is the darkest, most solid step),
// with "no supporting bill" rendered as a neutral absence rather than another
// blue. Each department's bar is 100%-stacked so the *mix* is comparable across
// departments of very different size; the absolute rupee figures live in the
// row label, the tooltip, the KPI, the sentence and the table twin. 2px surface
// gaps between segments; a legend is always present and a "View as table" twin
// carries every rupee figure (dataviz skill).
//
// Geometry is plain HTML segmented divs sized with `barWidthClass` (literal
// build-time Tailwind classes) — never a data-driven inline style, per this
// app's production style-src CSP (see lib/reports/bar-scale.ts).

/** Fixed best-to-worst order. Keys are also used by the section's grouping. */
const GROUP_KEYS = ['tax_invoice', 'bill_of_supply', 'other_bill', 'unclassified', 'no_document'] as const
type GroupKey = (typeof GROUP_KEYS)[number]

const GROUP_META: Record<GroupKey, { label: string; barClass: string }> = {
  tax_invoice: { label: 'Tax invoice', barClass: 'bg-[#184f95] dark:bg-[#184f95]' },
  bill_of_supply: { label: 'Bill of supply', barClass: 'bg-[#2a78d6] dark:bg-[#256abf]' },
  other_bill: { label: 'Other bill', barClass: 'bg-[#5598e7] dark:bg-[#3987e5]' },
  unclassified: { label: 'Not yet classified', barClass: 'bg-[#86b6ef] dark:bg-[#6da7ec]' },
  no_document: { label: 'No supporting bill', barClass: 'bg-muted-foreground/40' },
}

export type InstrumentMixDept = {
  key: number | string
  name: string
  total: number
  /** Rupees per group key (see GROUP_KEYS). Missing keys read as 0. */
  values: Record<string, number>
}

export function InstrumentMixChart({ departments }: { departments: InstrumentMixDept[] }) {
  const [showTable, setShowTable] = useState(false)
  const [hover, setHover] = useState<{ deptKey: string; group: GroupKey } | null>(null)

  if (departments.length === 0) return null

  const rows = departments.filter((d) => d.total > 0).sort((a, b) => b.total - a.total)
  if (rows.length === 0) return null

  const tableColumns: DataTableColumn<InstrumentMixDept>[] = [
    { key: 'dept', header: 'Department', render: (d) => d.name },
    ...GROUP_KEYS.map(
      (gk): DataTableColumn<InstrumentMixDept> => ({
        key: gk,
        header: GROUP_META[gk].label,
        align: 'right',
        render: (d) => ((d.values[gk] ?? 0) > 0 ? formatINR(d.values[gk] ?? 0) : '—'),
      })
    ),
    { key: 'total', header: 'Total', align: 'right', render: (d) => formatINR(d.total) },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex flex-col gap-2.5"
        role="img"
        aria-label="Instrument-type mix — each department's spend split by the kind of bill backing it, best-backed first. See the table view below for exact rupee figures."
        onPointerLeave={() => setHover(null)}
      >
        {rows.map((d) => {
          const active = hover && hover.deptKey === String(d.key) ? hover.group : null
          return (
            <div key={d.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="truncate text-foreground">{d.name}</span>
                <span className="shrink-0 font-mono text-muted-foreground">
                  {active
                    ? `${GROUP_META[active].label}: ${formatINRCompact(d.values[active] ?? 0)} · ${formatPercent(
                        ((d.values[active] ?? 0) / d.total) * 100
                      )}`
                    : formatINRCompact(d.total)}
                </span>
              </div>
              <div className="flex h-4 w-full gap-[2px] overflow-hidden rounded-sm bg-secondary">
                {GROUP_KEYS.map((gk) => {
                  const v = d.values[gk] ?? 0
                  if (v <= 0) return null
                  const pct = (v / d.total) * 100
                  return (
                    <div
                      key={gk}
                      className={cn('h-full', GROUP_META[gk].barClass, barWidthClass(pct))}
                      title={`${d.name} · ${GROUP_META[gk].label}: ${formatINR(v)} (${formatPercent(pct)})`}
                      onPointerEnter={() => setHover({ deptKey: String(d.key), group: gk })}
                    />
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {GROUP_KEYS.map((gk) => (
          <span key={gk} className="flex items-center gap-1.5">
            <span className={cn('h-2.5 w-2.5 rounded-sm', GROUP_META[gk].barClass)} />
            {GROUP_META[gk].label}
          </span>
        ))}
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
