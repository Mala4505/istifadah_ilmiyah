'use client'

import { useState } from 'react'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import { ORDINAL_RAMP } from './ordinal-ramp'

// reporting-blueprint.md D-02 — amount-at-risk waterfall. "Total spend →
// flagged → confirmed → recovered or dismissed. The value the review function
// actually delivered, in one figure." A horizontal, left-anchored run of
// descending ₹ stages, the drop between consecutive stages spelled out, so the
// eye lands on "how much of the total was ever in question, and how much of
// that the review function has since closed."
//
// Modelled on funnel-chart.tsx: a fixed internal SVG coordinate space with
// real numeric attributes for the bar geometry (exempt from this app's
// style-src CSP constraint — see lib/reports/bar-scale.ts), ORDINAL_RAMP for
// the stage colour (position in a fixed sequence, one hue, monotone steps —
// never a per-stage hue), and drop-off labels between stages. Left-anchored
// rather than centre-anchored: a waterfall reads as a descending staircase
// from a common origin. Every figure is already on the face of the chart as
// text; the "View as table" twin adds the % of prior stage.

export type WaterfallStage = {
  key: string
  label: string
  amount: number
  /** null for stages with no meaningful item count (e.g. total spend). */
  count: number | null
}

const VIEW_WIDTH = 1000
const BAR_HEIGHT = 26
const RADIUS = 4

export function WaterfallChart({ stages }: { stages: WaterfallStage[] }) {
  const [showTable, setShowTable] = useState(false)

  if (stages.length === 0) return null
  const base = Math.max(1, stages[0]!.amount)

  const tableRows = stages.map((stage, i) => {
    const prev = i > 0 ? stages[i - 1]! : null
    return {
      ...stage,
      pctOfPrior: prev && prev.amount > 0 ? (stage.amount / prev.amount) * 100 : null,
    }
  })
  type TableRow = (typeof tableRows)[number]

  const tableColumns: DataTableColumn<TableRow>[] = [
    { key: 'stage', header: 'Stage', render: (s) => s.label },
    { key: 'amount', header: '₹', align: 'right', render: (s) => formatINR(s.amount) },
    { key: 'count', header: 'Count', align: 'right', render: (s) => (s.count == null ? '—' : formatNumber(s.count)) },
    {
      key: 'pct',
      header: '% of prior stage',
      align: 'right',
      render: (s) => (s.pctOfPrior == null ? '—' : formatPercent(s.pctOfPrior)),
    },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex flex-col gap-2"
        role="img"
        aria-label={`Amount-at-risk waterfall — ${stages
          .map((s) => `${s.label} ${formatINRCompact(s.amount)}`)
          .join(', ')}. See the table view below for exact values.`}
      >
        {stages.map((stage, i) => {
          const fraction = Math.max(0, Math.min(1, stage.amount / base))
          const barWidth = fraction * VIEW_WIDTH
          const ramp = ORDINAL_RAMP[Math.min(i, ORDINAL_RAMP.length - 1)]!
          const prev = i > 0 ? stages[i - 1]! : null
          const drop = prev ? prev.amount - stage.amount : null

          return (
            <div key={stage.key} className="flex flex-col gap-1">
              {drop != null && drop > 0 && (
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  &minus;{formatINRCompact(drop)} from {prev!.label.toLowerCase()}
                </p>
              )}
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="truncate text-foreground">{stage.label}</span>
                <span className="shrink-0 font-mono text-muted-foreground">
                  {formatINRCompact(stage.amount)}
                  {stage.count != null && ` · ${formatNumber(stage.count)} ${stage.count === 1 ? 'item' : 'items'}`}
                </span>
              </div>
              <svg
                viewBox={`0 0 ${VIEW_WIDTH} ${BAR_HEIGHT}`}
                width="100%"
                height={BAR_HEIGHT}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <rect x={0} y={0} width={VIEW_WIDTH} height={BAR_HEIGHT} rx={RADIUS} className="fill-secondary" />
                <rect x={0} y={0} width={barWidth} height={BAR_HEIGHT} rx={RADIUS} className={ramp.fillClass} />
              </svg>
            </div>
          )
        })}
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={tableRows} getRowKey={(s) => s.key} />}
    </div>
  )
}
