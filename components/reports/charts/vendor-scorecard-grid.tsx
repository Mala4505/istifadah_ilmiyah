'use client'

import { useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import { barWidthClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

// PRICE_POSITION_TOLERANCE is duplicated from lib/reports/surfaces/vendor-scorecard.ts
// rather than imported: that module also exports the server-only Supabase
// loader (`createClient` from '@/lib/supabase/server', which pulls in
// `next/headers`), and this is a Client Component — importing anything from
// that file at all would drag the server-only chain into the client bundle
// (same class of boundary trend-chart.tsx's header documents for why it
// takes a format *name* instead of a function). Keep this value in sync with
// the constant of the same name there if it ever changes.

// reporting-blueprint.md B-02: "One card per vendor: spend, share, price
// against our benchmark, discount given, document quality, GSTIN validity,
// flag history. A supplier rating you could put in front of the supplier."
//
// Rendered as a compact row grid, not a full SVG axis chart, on purpose: the
// task brief itself names `barWidthClass` for the spend bar, and this app's
// existing bar-list.tsx is exactly that pattern — an HTML bar built from a
// literal Tailwind width class rather than an inline `style` attribute
// (lib/reports/bar-scale.ts's header explains why: production CSP's
// style-src carries no 'unsafe-inline', so a computed width has to come from
// the compiled class list, not a style prop). A second axis-based chart
// would only re-plot the same one number (spend) this pattern already
// renders; the value this component adds over bar-list.tsx is the row of
// status pills next to each bar. Interactivity per the dataviz skill still
// applies: each pill carries a native `title` hover explanation, the whole
// row is one focusable, keyboard-reachable link with a descriptive
// aria-label, and a required "View as table" toggle renders every value
// shown here as plain text.

export type ScorecardGridVendor = {
  vendorId: number
  vendorName: string
  spend: number
  sharePct: number | null
  priceRatio: number | null
  pricedObservationCount: number
  gstinStatus: 'missing' | 'flagged' | 'valid'
  docCoveragePct: number | null
  openFlagCount: number
  flagHistoryCount: number
}

const PRICE_POSITION_TOLERANCE = 0.05

type SortKey = 'spend' | 'price' | 'flags'

const SORT_LABEL: Record<SortKey, string> = {
  spend: 'Spend',
  price: 'Price position',
  flags: 'Open flags',
}

function pricePresentation(row: ScorecardGridVendor): { icon: string; label: string; colorClass: string; title: string } {
  if (row.priceRatio == null) {
    return {
      icon: '—',
      label: 'no benchmark',
      colorClass: 'text-muted-foreground',
      title: 'No comparable priced observations yet for this vendor',
    }
  }
  const ratioLabel = `${row.priceRatio.toFixed(2)}× median`
  if (row.priceRatio > 1 + PRICE_POSITION_TOLERANCE) {
    return {
      icon: '▲',
      label: ratioLabel,
      colorClass: 'text-red-700 dark:text-red-300',
      title: `Averages ${ratioLabel} of our own benchmark across ${row.pricedObservationCount} comparable observation${row.pricedObservationCount === 1 ? '' : 's'} — priced above it`,
    }
  }
  if (row.priceRatio < 1 - PRICE_POSITION_TOLERANCE) {
    return {
      icon: '▼',
      label: ratioLabel,
      colorClass: 'text-emerald-800 dark:text-emerald-300',
      title: `Averages ${ratioLabel} of our own benchmark across ${row.pricedObservationCount} comparable observation${row.pricedObservationCount === 1 ? '' : 's'} — priced below it`,
    }
  }
  return {
    icon: '≈',
    label: ratioLabel,
    colorClass: 'text-muted-foreground',
    title: `Averages ${ratioLabel} of our own benchmark across ${row.pricedObservationCount} comparable observation${row.pricedObservationCount === 1 ? '' : 's'} — near it`,
  }
}

function gstinPresentation(status: ScorecardGridVendor['gstinStatus']): { icon: string; label: string; colorClass: string; title: string } {
  if (status === 'valid') {
    return {
      icon: '✓',
      label: 'valid',
      colorClass: 'text-emerald-800 dark:text-emerald-300',
      title: 'GSTIN on file, no open checksum or self-billing exception',
    }
  }
  if (status === 'flagged') {
    return {
      icon: '⚠',
      label: 'flagged',
      colorClass: 'text-red-700 dark:text-red-300',
      title: 'GSTIN on file but has an open checksum-failure or self-billing exception',
    }
  }
  return {
    icon: '—',
    label: 'missing',
    colorClass: 'text-muted-foreground',
    title: 'No GSTIN on file for this vendor',
  }
}

export function VendorScorecardGrid({ vendors }: { vendors: ScorecardGridVendor[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('spend')
  const [showTable, setShowTable] = useState(false)

  if (vendors.length === 0) return null

  const sorted = [...vendors].sort((a, b) => {
    if (sortKey === 'price') return (b.priceRatio ?? -Infinity) - (a.priceRatio ?? -Infinity)
    if (sortKey === 'flags') return b.openFlagCount - a.openFlagCount || b.flagHistoryCount - a.flagHistoryCount
    return b.spend - a.spend
  })

  const maxSpend = Math.max(1, ...vendors.map((v) => v.spend))

  const tableColumns: DataTableColumn<ScorecardGridVendor>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (v) => (
        <Link href={`/entries?vendor_id=${v.vendorId}`} className="text-primary underline-offset-2 hover:underline">
          {v.vendorName}
        </Link>
      ),
    },
    { key: 'spend', header: 'Spend', align: 'right', render: (v) => formatINRCompact(v.spend) },
    { key: 'share', header: 'Share', align: 'right', render: (v) => formatPercent(v.sharePct) },
    { key: 'price', header: 'Price vs benchmark', render: (v) => pricePresentation(v).label },
    { key: 'docs', header: 'Doc coverage', align: 'right', render: (v) => formatPercent(v.docCoveragePct) },
    { key: 'gstin', header: 'GSTIN', render: (v) => gstinPresentation(v.gstinStatus).label },
    { key: 'flags', header: 'Open flags', align: 'right', render: (v) => formatNumber(v.openFlagCount) },
    { key: 'history', header: 'Flag history', align: 'right', render: (v) => formatNumber(v.flagHistoryCount) },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Sort by</span>
        {(['spend', 'price', 'flags'] as const).map((key) => (
          <Button
            key={key}
            type="button"
            size="sm"
            variant={sortKey === key ? 'default' : 'outline'}
            onClick={() => setSortKey(key)}
            aria-pressed={sortKey === key}
          >
            {SORT_LABEL[key]}
          </Button>
        ))}
      </div>

      <ul className="flex flex-col gap-2" aria-label="Vendor scorecards, one row per vendor">
        {sorted.map((v) => {
          const pct = Math.max(0, Math.min(100, (v.spend / maxSpend) * 100))
          const price = pricePresentation(v)
          const gstin = gstinPresentation(v.gstinStatus)
          return (
            <li key={v.vendorId}>
              <Link
                href={`/entries?vendor_id=${v.vendorId}`}
                className="flex flex-col gap-1.5 rounded-md border border-border p-2.5 transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`${v.vendorName}: ${formatINRCompact(v.spend)} spend, priced ${price.label} our benchmark, GSTIN ${gstin.label}, ${formatNumber(v.openFlagCount)} open flag${v.openFlagCount === 1 ? '' : 's'}`}
              >
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="truncate font-medium text-foreground">{v.vendorName}</span>
                  <span className="flex shrink-0 items-baseline gap-1.5 font-mono text-muted-foreground">
                    {formatINRCompact(v.spend)}
                    {v.sharePct != null && (
                      <span className="text-[10px] font-sans text-muted-foreground/80">({formatPercent(v.sharePct)})</span>
                    )}
                  </span>
                </div>
                <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div className={cn('h-full rounded-full bg-[#2a78d6] dark:bg-[#3987e5]', barWidthClass(pct))} />
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                  <span className={cn('flex items-center gap-1', price.colorClass)} title={price.title}>
                    <span aria-hidden="true">{price.icon}</span>
                    {price.label}
                  </span>
                  <span className={cn('flex items-center gap-1', gstin.colorClass)} title={gstin.title}>
                    <span aria-hidden="true">{gstin.icon}</span>
                    GSTIN {gstin.label}
                  </span>
                  <span className="text-muted-foreground">
                    Docs {v.docCoveragePct != null ? formatPercent(v.docCoveragePct) : '—'}
                  </span>
                  <span
                    className={cn(v.openFlagCount > 0 ? 'font-medium text-red-700 dark:text-red-300' : 'text-muted-foreground')}
                    title={`${formatNumber(v.flagHistoryCount)} flag${v.flagHistoryCount === 1 ? '' : 's'} in this vendor's full history`}
                  >
                    {formatNumber(v.openFlagCount)} open flag{v.openFlagCount === 1 ? '' : 's'}
                  </span>
                </div>
              </Link>
            </li>
          )
        })}
      </ul>

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((x) => !x)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={sorted} getRowKey={(v) => v.vendorId} />}
    </div>
  )
}
