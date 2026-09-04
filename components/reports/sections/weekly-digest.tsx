import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact } from '@/lib/reports/format'
import type { WeeklyDigestCategory, WeeklyDigestItem } from '@/lib/reports/weekly-digest'

// reporting-blueprint.md §3 E-04 -- "The ten things most worth attention this
// week, ranked by rupees, each written as a plain sentence with an owner. The
// only report a busy person reads end to end." Pure Server Component: a numbered
// list where the whole row links to the entries / report behind the line, plus
// one CSV button and a computed one-line summary. No chart, no interactive
// client component -- the sentence IS the visualisation here (§6 fix #3).

const CATEGORY_LABEL: Record<WeeklyDigestCategory, string> = {
  compliance_flag: 'compliance flags',
  reconciliation: 'reconciliation gaps',
  budget_pace: 'budget pace',
  overpayment: 'overpayment',
  rate_drift: 'rate drift',
  new_vendor: 'new vendors',
}

function ageLabel(ageDays: number | null): string {
  if (ageDays == null) return 'as of today'
  if (ageDays === 0) return 'today'
  if (ageDays === 1) return 'yesterday'
  return `${ageDays} days ago`
}

/** "Ten items, ₹4.2 L in total, led by overpayment." -- the one computed line
 *  above the list (§6 fix #3: a sentence, not just a chart). Pure function of
 *  the rows. */
export function weeklyDigestSummary(items: WeeklyDigestItem[]): string {
  if (items.length === 0) return 'Nothing crossed the threshold this week.'
  const total = items.reduce((sum, i) => sum + (i.amount ?? 0), 0)
  const byCategory = new Map<WeeklyDigestCategory, number>()
  for (const i of items) byCategory.set(i.category, (byCategory.get(i.category) ?? 0) + (i.amount ?? 0))
  const lead = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0]
  const countWord = items.length === 1 ? '1 item' : `${items.length} items`
  const leadClause = lead ? `, led by ${CATEGORY_LABEL[lead[0]]}` : ''
  return `${countWord}, ${formatINRCompact(total)} in total${leadClause}.`
}

export function WeeklyDigestSection({
  items,
  hasError,
  errorText,
}: {
  items: WeeklyDigestItem[]
  hasError: boolean
  errorText: string | null
}) {
  const csv = toCsv(items, [
    { header: 'Rank', value: (r) => r.rank },
    { header: 'What', value: (r) => r.headline },
    { header: '₹', value: (r) => r.amount },
    { header: 'Owner', value: (r) => r.owner },
    { header: 'Age (days)', value: (r) => r.ageDays },
    { header: 'Category', value: (r) => CATEGORY_LABEL[r.category] },
    { header: 'Link', value: (r) => r.href },
  ])

  return (
    <ReportSection
      id="weekly-digest"
      title="Weekly digest"
      description="The ten things most worth attention this week, ranked by rupees. Each line links to the entries behind it. The only report a busy person reads end to end."
      action={<ExportCsvButton csv={csv} rowCount={items.length} filename="weekly-digest.csv" />}
    >
      {hasError && items.length === 0 ? (
        <EmptyState title="Couldn't load the weekly digest" description={errorText ?? undefined} />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing crossed the threshold this week"
          description="No new or worsening findings, budget-pace breaches, overpayment spikes, rate drift or new-vendor bills in the last 7 days."
        />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{weeklyDigestSummary(items)}</p>
          {errorText && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Some sources could not be loaded — this list may be incomplete. {errorText}
            </p>
          )}
          <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
            {items.map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="grid grid-cols-[1.5rem_1fr_auto] items-baseline gap-x-3 gap-y-0.5 px-3 py-2.5 hover:bg-muted/50"
                >
                  <span className="text-xs tabular-nums text-muted-foreground">{item.rank}.</span>
                  <span className="text-sm text-foreground">
                    {item.headline}
                    <span className="text-muted-foreground"> — {item.owner}</span>
                    <span className="text-xs text-muted-foreground"> ({ageLabel(item.ageDays)})</span>
                  </span>
                  <span className="text-right text-sm font-medium tabular-nums text-foreground">
                    {item.amount != null ? formatINR(item.amount) : '—'}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}
    </ReportSection>
  )
}
