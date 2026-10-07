import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { DonutChart, type DonutSegment } from '@/components/reports/charts/donut-chart'
import { MAX_CATEGORICAL, OTHER_STEP, slotForKey } from '@/components/reports/charts/categorical-palette'
import { toCsv } from '@/lib/reports/csv'
import { formatDate, formatINR, formatINRCompact, formatNumber, humanizeCode } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import {
  type ReimbursementByTypeRow,
  type ReimbursementProfileRow,
} from '@/lib/reports/surfaces/entry-type-flow'

// reporting-blueprint.md A-10 — reimbursement profile. "Who is reimbursed,
// how often, how much, for what type. Reimbursements bypass the normal vendor
// path." A reimbursee is keyed to a real vendor when the import linked one,
// otherwise to a normalised form of the free-text "reimburse to" name — so two
// spellings of the same un-linked person are two reimbursees until someone
// links them (documented in the view header).

const TOP_BAR_COUNT = 12
// v_reimbursement_by_type folds blank types into this literal (migration
// 20260903000014) -- it isn't an identity, so it never takes a hue.
const UNSPECIFIED_TYPE = '(unspecified)'

/** "{reimbursee} is the largest reimbursee at ₹X; {type} is the dominant
 *  reimbursement type." (§6 fix #3) */
export function reimbursementProfileSentence(
  rows: ReimbursementProfileRow[],
  byType: ReimbursementByTypeRow[]
): string {
  if (rows.length === 0) return 'No reimbursements recorded yet this event.'
  const total = rows.reduce((s, r) => s + (r.total_amount ?? 0), 0)
  const lead = [...rows].sort((a, b) => (b.total_amount ?? 0) - (a.total_amount ?? 0))[0]!
  const topType = [...byType].sort((a, b) => (b.total_amount ?? 0) - (a.total_amount ?? 0))[0]
  const typeBit = topType
    ? ` — ${humanizeCode(topType.reimbursement_type)} is the dominant type at ${formatINRCompact(topType.total_amount)}`
    : ''
  return `${formatNumber(rows.length)} reimbursee${rows.length === 1 ? '' : 's'} drew ${formatINRCompact(
    total
  )} this event; ${lead.reimbursee_name} is the largest at ${formatINRCompact(lead.total_amount)}${typeBit}.`
}

// Colour follows the reimbursement TYPE, not its rank (dataviz: colour follows
// the entity): reimbursement_type is free text with no fixed code list, so
// hues are keyed off the type codes in alphabetical order. A type keeps its
// hue when its ₹ total overtakes another's -- the old reversed ordinal ramp
// repainted every slice whenever the ranking shifted. Past 6 named types the
// smallest fold into a neutral "Other" (alphabetical slots then apply to the
// 5 kept), and "(unspecified)" always sits in that neutral bucket.
function donutSegments(byType: ReimbursementByTypeRow[]): DonutSegment[] {
  const positive = byType.filter((r) => (r.total_amount ?? 0) > 0)
  const named = positive
    .filter((r) => r.reimbursement_type !== UNSPECIFIED_TYPE)
    .sort((a, b) => b.total_amount - a.total_amount)
  if (positive.length === 0) return []
  const kept = named.length <= MAX_CATEGORICAL ? named : named.slice(0, MAX_CATEGORICAL - 1)
  const tail = positive.filter((r) => !kept.includes(r))
  const order = kept.map((r) => r.reimbursement_type).sort((a, b) => a.localeCompare(b))
  const segments: DonutSegment[] = kept.map((r) => ({
    key: r.reimbursement_type,
    label: humanizeCode(r.reimbursement_type),
    value: r.total_amount,
    colorClass: slotForKey(r.reimbursement_type, order).strokeClass,
    hex: slotForKey(r.reimbursement_type, order).hex,
  }))
  if (tail.length > 0) {
    const onlyUnspecified = tail.length === 1 && tail[0]!.reimbursement_type === UNSPECIFIED_TYPE
    segments.push({
      key: '__other__',
      label: onlyUnspecified ? 'Unspecified' : `Other (${formatNumber(tail.length)} types)`,
      value: tail.reduce((s, r) => s + r.total_amount, 0),
      colorClass: OTHER_STEP.strokeClass,
      hex: OTHER_STEP.hex,
    })
  }
  return segments
}

export function ReimbursementProfileSection({
  rows,
  byType,
  error,
  byTypeError,
  compareBasis,
  previousTotalReimbursed,
  previousReimburseeCount,
  insight,
}: {
  rows: ReimbursementProfileRow[]
  byType: ReimbursementByTypeRow[]
  error: string | null
  byTypeError: string | null
  compareBasis: CompareBasis
  previousTotalReimbursed: number | null
  previousReimburseeCount: number | null
  insight?: string | null
}) {
  const total = rows.reduce((s, r) => s + (r.total_amount ?? 0), 0)
  const prevTotal = compareBasis === 'prior_event' ? previousTotalReimbursed : null
  const prevCount = compareBasis === 'prior_event' ? previousReimburseeCount : null

  const ranked = [...rows].sort((a, b) => (b.total_amount ?? 0) - (a.total_amount ?? 0))

  const barItems: BarListItem[] = ranked.slice(0, TOP_BAR_COUNT).map((r) => ({
    key: r.reimbursee_key,
    label: r.reimbursee_name,
    value: r.total_amount ?? 0,
    href: r.department_id != null ? `/entries?dept=${r.department_id}&tp=reimbursement` : undefined,
  }))

  const segments = donutSegments(byType)

  const columns: DataTableColumn<ReimbursementProfileRow>[] = [
    {
      key: 'reimbursee',
      header: 'Reimbursee',
      render: (r) =>
        r.reimburse_to_vendor_id != null ? (
          <Link
            href={`/entries?vendor=${encodeURIComponent(r.reimbursee_name)}`}
            className="text-primary underline-offset-2 hover:underline"
          >
            {r.reimbursee_name}
          </Link>
        ) : (
          r.reimbursee_name
        ),
    },
    {
      key: 'department',
      header: 'Modal department',
      render: (r) =>
        r.department_id != null ? (
          <Link
            href={`/entries?dept=${r.department_id}&tp=reimbursement`}
            className="text-primary underline-offset-2 hover:underline"
          >
            {r.department_name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
    { key: 'amount', header: 'Reimbursed', align: 'right', render: (r) => formatINR(r.total_amount) },
    { key: 'first', header: 'First', render: (r) => formatDate(r.first_date) },
    { key: 'last', header: 'Last', render: (r) => formatDate(r.last_date) },
  ]

  return (
    <ReportSection
      id="reimbursement-profile"
      title="Reimbursement profile"
      description="Who is reimbursed, how often, how much and for what type. Reimbursements bypass the normal vendor path, so this is where to check that the people being paid back are the people who should be."
      action={
        <ExportCsvButton
          filename="reimbursement-profile.csv"
          rowCount={rows.length}
          csv={toCsv(ranked, [
            { header: 'Reimbursee', value: (r) => r.reimbursee_name },
            { header: 'Linked vendor ID', value: (r) => r.reimburse_to_vendor_id },
            { header: 'Modal department', value: (r) => r.department_name },
            { header: 'Entries', value: (r) => r.entry_count },
            { header: 'Reimbursed', value: (r) => r.total_amount },
            { header: 'First', value: (r) => r.first_date },
            { header: 'Last', value: (r) => r.last_date },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load the reimbursement profile" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No reimbursements yet"
          description="Reimbursement entries and their 'reimburse to' details appear here for the selected event."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <KpiTile
              label="Total reimbursed"
              value={formatINRCompact(total)}
              delta={formatDeltaVs(compareBasis, total, prevTotal, 'inr')}
              deltaTone={deltaToneHigherIsBad(total, prevTotal)}
            />
            <KpiTile
              label="Distinct reimbursees"
              value={formatNumber(rows.length)}
              delta={formatDeltaVs(compareBasis, rows.length, prevCount, 'count')}
              deltaTone={deltaToneHigherIsBad(rows.length, prevCount)}
            />
          </div>
          <p className="text-sm text-muted-foreground">{insight ?? reimbursementProfileSentence(rows, byType)}</p>
          <BarList items={barItems} valueFormatter={formatINRCompact} />
          {byTypeError ? (
            <p className="text-xs text-muted-foreground">Reimbursement-type mix unavailable: {byTypeError}</p>
          ) : (
            segments.length > 0 && <DonutChart segments={segments} centerLabel="Type mix" valueFormat="inr-compact" />
          )}
          <DataTable columns={columns} rows={ranked} getRowKey={(r) => r.reimbursee_key} />
        </>
      )}
    </ReportSection>
  )
}
