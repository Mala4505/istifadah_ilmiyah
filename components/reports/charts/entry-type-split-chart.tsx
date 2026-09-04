'use client'

import { useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { formatINR, formatINRCompact, formatPercent } from '@/lib/reports/format'
import { barWidthClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md A-08 §5: "Invoice vs reimbursement vs advance vs
// invoice-against-uplaq, per department. A high reimbursement share is a
// control signal." Stacked bar per department, 100%-stacked so the *mix* is
// comparable across departments of very different size; the absolute rupee
// figures live in the row label, the tooltip, the KPI, the sentence and the
// table twin.
//
// Colour (dataviz skill / §6 fix #5): reimbursement is the control signal, so
// it takes the reserved warn hue (amber) with a legend label; the other three
// types are neutral spend and take steps of this screen's blue ordinal ramp
// (charts/ordinal-ramp.ts) in a fixed order. Never a generated/cycled hue.
//
// Geometry is plain HTML segmented divs sized with `barWidthClass` (literal
// build-time Tailwind classes), never a data-driven inline style -- this app's
// production style-src CSP has no 'unsafe-inline' (see lib/reports/bar-scale.ts).
//
// This is a 'use client' module: it imports NO runtime value from
// lib/reports/surfaces/entry-type-flow.ts (which pulls in next/headers via the
// server Supabase client). The section owns the raw-code -> ₹ mapping; this
// chart owns the key order, labels and colours. The four codes below are the
// entries_type_check values (20260828000002) -- keep in sync if that changes.

const SPLIT_KEYS = ['invoice', 'invoice_against_uplaq', 'advance_payment', 'reimbursement'] as const
type SplitKey = (typeof SPLIT_KEYS)[number]

const SPLIT_META: Record<SplitKey, { label: string; barClass: string; swatchClass: string }> = {
  invoice: {
    label: 'Invoice',
    barClass: 'bg-[#184f95] dark:bg-[#184f95]',
    swatchClass: 'bg-[#184f95] dark:bg-[#184f95]',
  },
  invoice_against_uplaq: {
    label: 'Invoice against uplaq',
    barClass: 'bg-[#2a78d6] dark:bg-[#256abf]',
    swatchClass: 'bg-[#2a78d6] dark:bg-[#256abf]',
  },
  advance_payment: {
    label: 'Advance',
    barClass: 'bg-[#86b6ef] dark:bg-[#6da7ec]',
    swatchClass: 'bg-[#86b6ef] dark:bg-[#6da7ec]',
  },
  reimbursement: {
    label: 'Reimbursement (control signal)',
    barClass: 'bg-amber-500 dark:bg-amber-400',
    swatchClass: 'bg-amber-500 dark:bg-amber-400',
  },
}

export type EntryTypeSplitDept = {
  key: number | string
  /** department_id, or null for the no-department bucket. */
  departmentId: number | null
  name: string
  total: number
  /** Rupees per raw entries.type code. Missing keys read as 0. */
  values: Record<string, number>
}

function deptHref(departmentId: number | null, code?: SplitKey): string | null {
  if (departmentId == null) return null
  const base = `/entries?dept=${departmentId}`
  return code ? `${base}&tp=${code}` : base
}

export function EntryTypeSplitChart({ departments }: { departments: EntryTypeSplitDept[] }) {
  const [showTable, setShowTable] = useState(false)
  const [hover, setHover] = useState<{ deptKey: string; key: SplitKey } | null>(null)

  const rows = departments.filter((d) => d.total > 0).sort((a, b) => b.total - a.total)
  if (rows.length === 0) return null

  const tableColumns: DataTableColumn<EntryTypeSplitDept>[] = [
    { key: 'dept', header: 'Department', render: (d) => d.name },
    ...SPLIT_KEYS.map(
      (k): DataTableColumn<EntryTypeSplitDept> => ({
        key: k,
        header: SPLIT_META[k].label,
        align: 'right',
        render: (d) => ((d.values[k] ?? 0) > 0 ? formatINR(d.values[k] ?? 0) : '—'),
      })
    ),
    { key: 'total', header: 'Total', align: 'right', render: (d) => formatINR(d.total) },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex flex-col gap-2.5"
        role="img"
        aria-label="Entry-type split — each department's spend split by entry type (invoice, invoice against uplaq, advance, reimbursement), measured in rupees. See the table view below for exact figures."
        onPointerLeave={() => setHover(null)}
      >
        {rows.map((d) => {
          const active = hover && hover.deptKey === String(d.key) ? hover.key : null
          const labelHref = deptHref(d.departmentId)
          return (
            <div key={d.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                {labelHref ? (
                  <Link href={labelHref} className="truncate text-foreground underline-offset-2 hover:underline">
                    {d.name}
                  </Link>
                ) : (
                  <span className="truncate text-muted-foreground">{d.name}</span>
                )}
                <span className="shrink-0 font-mono text-muted-foreground">
                  {active
                    ? `${SPLIT_META[active].label}: ${formatINRCompact(d.values[active] ?? 0)} · ${formatPercent(
                        ((d.values[active] ?? 0) / d.total) * 100
                      )}`
                    : formatINRCompact(d.total)}
                </span>
              </div>
              <div className="flex h-4 w-full gap-[2px] overflow-hidden rounded-sm bg-secondary">
                {SPLIT_KEYS.map((k) => {
                  const v = d.values[k] ?? 0
                  if (v <= 0) return null
                  const pct = (v / d.total) * 100
                  const segHref = deptHref(d.departmentId, k)
                  const title = `${d.name} · ${SPLIT_META[k].label}: ${formatINR(v)} (${formatPercent(pct)})`
                  const fill = (
                    <span
                      className={cn('block h-full w-full', SPLIT_META[k].barClass)}
                      title={title}
                      onPointerEnter={() => setHover({ deptKey: String(d.key), key: k })}
                    />
                  )
                  return (
                    <div key={k} className={cn('h-full', barWidthClass(pct))}>
                      {segHref ? (
                        <Link href={segHref} className="block h-full">
                          {fill}
                        </Link>
                      ) : (
                        fill
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {SPLIT_KEYS.map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={cn('h-2.5 w-2.5 rounded-sm', SPLIT_META[k].swatchClass)} />
            {SPLIT_META[k].label}
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
