import { FileClock, FileCheck2, Files } from 'lucide-react'
import { StatTile } from '@/components/dashboard/stat-tile'
import { formatNumber, formatPercent } from '@/lib/reports/format'
import type { EntryBillKpis } from '@/lib/documents/entry-bill-kpis'

/**
 * "Waiting on a bill" KPIs for the /entries header (operator request,
 * 2026-09-07) -- the entry-side mirror of components/documents/bill-kpi-bar.tsx.
 * /documents says how many scanned bills are left to review; this says how
 * many entries have no bill attached at all.
 *
 * Server component -- it only lays out the counts getEntryBillKpis produced.
 * The two linked tiles deep-link into the list's own filters ("Awaiting bill"
 * = `abill=1`, "Bill attached" = `doc=1`), which entries-explorer.tsx reads
 * back on navigation.
 */
export function EntryBillKpiBar({ kpis }: { kpis: EntryBillKpis }) {
  if (kpis.total === 0) return null

  const pct = kpis.total > 0 ? Math.round((kpis.withDocument / kpis.total) * 100) : 0

  return (
    <section aria-label="Bill coverage" className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label="Entries awaiting a bill"
          value={formatNumber(kpis.awaitingDocument)}
          hint={
            kpis.awaitingDocument === 0
              ? 'Every entry has a document'
              : `${formatPercent(100 - pct)} of ${formatNumber(kpis.total)} entries`
          }
          href="/entries?abill=1"
          icon={FileClock}
          tone={kpis.awaitingDocument > 0 ? 'warning' : 'default'}
        />
        <StatTile
          label="Entries with a bill"
          value={formatNumber(kpis.withDocument)}
          hint={`${formatPercent(pct)} of ${formatNumber(kpis.total)} entries`}
          href="/entries?doc=1"
          icon={FileCheck2}
        />
        <StatTile
          label="Total entries"
          value={formatNumber(kpis.total)}
          hint="Non-void, this event"
          icon={Files}
        />
      </div>

      <div className="flex items-center gap-3">
        <div
          className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Entries with a bill"
        >
          <div
            className="h-full rounded-full bg-emerald-600 transition-[width] dark:bg-emerald-500"
            style={{ width: `${Math.max(pct, kpis.withDocument > 0 ? 3 : 0)}%` }}
          />
        </div>
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {formatNumber(kpis.withDocument)} / {formatNumber(kpis.total)}
        </span>
      </div>
    </section>
  )
}
