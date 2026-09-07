import { ClipboardCheck, ListChecks, FileStack } from 'lucide-react'
import { StatTile } from '@/components/dashboard/stat-tile'
import { formatNumber, formatPercent } from '@/lib/reports/format'
import type { BillKpis } from '@/lib/documents/bill-kpis'

/**
 * Review-progress KPIs for the /documents header (2026-09-07 request:
 * "show the user KPIs of the bills that are left to review and total etc").
 * Server component -- it just lays out the counts `getBillKpis` produced.
 *
 * `scope` only changes the wording:
 *   'mine' -> a regular admin; counts restricted to their assigned documents
 *   'all'  -> a superadmin; counts across the whole selected event
 *   'open' -> dept / anyone else; counts over what they can see (the pool)
 */
export function BillKpiBar({ kpis, scope }: { kpis: BillKpis; scope: 'mine' | 'all' | 'open' }) {
  const own = scope === 'mine'
  // 'open' == dept, who can't open /review (admins only) -- don't hand them a
  // tile that just lands on a permission gate.
  const reviewHref = scope === 'open' ? undefined : '/review'

  if (kpis.emptyScope) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
        No documents are assigned to you yet — a superadmin hands work out from the inbox. Review
        progress will show here once you have some.
      </div>
    )
  }

  const pct = kpis.total > 0 ? Math.round((kpis.reviewed / kpis.total) * 100) : 0

  return (
    <section aria-label="Review progress" className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label={own ? 'Your bills to review' : 'Bills to review'}
          value={formatNumber(kpis.toReview)}
          hint={
            kpis.toReview === 0
              ? 'Everything is reviewed'
              : `${formatNumber(kpis.unverified)} not verified · ${formatNumber(
                  kpis.verifiedIncomplete
                )} need connect / classify`
          }
          href={reviewHref}
          icon={ClipboardCheck}
          tone={kpis.toReview > 0 ? 'warning' : 'default'}
        />
        <StatTile
          label={own ? 'Your bills reviewed' : 'Bills reviewed'}
          value={formatNumber(kpis.reviewed)}
          hint={
            kpis.total === 0
              ? 'No bills extracted yet'
              : `${formatPercent(pct)} of ${formatNumber(kpis.total)} total`
          }
          icon={ListChecks}
        />
        <StatTile
          label={own ? 'Your total bills' : 'Total bills'}
          value={formatNumber(kpis.total)}
          hint={
            kpis.pdfsInInbox === 0
              ? 'Inbox is clear'
              : `${formatNumber(kpis.pdfsInInbox)} PDF${kpis.pdfsInInbox === 1 ? '' : 's'} still in the inbox`
          }
          icon={FileStack}
        />
      </div>

      {kpis.total > 0 && (
        <div className="flex items-center gap-3">
          <div
            className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={own ? 'Your bills reviewed' : 'Bills reviewed'}
          >
            <div
              className="h-full rounded-full bg-emerald-600 transition-[width] dark:bg-emerald-500"
              style={{ width: `${Math.max(pct, kpis.reviewed > 0 ? 3 : 0)}%` }}
            />
          </div>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {formatNumber(kpis.reviewed)} / {formatNumber(kpis.total)}
          </span>
        </div>
      )}
    </section>
  )
}
