import type { ReactNode } from 'react'
import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { toCsv } from '@/lib/reports/csv'
import {
  formatINR,
  formatINRCompact,
  formatNumber,
  formatPercent,
  formatDate,
  humanizeCode,
} from '@/lib/reports/format'
import { INSTRUMENT_TYPE_LABELS } from '@/lib/reports/sections/shared'
import type {
  RupeeProvenanceChain,
  RupeeProvenanceEntryRow,
  RupeeProvenanceLineRow,
} from '@/lib/reports/surfaces/rupee-provenance'
import {
  RupeeProvenancePicker,
  type RupeeProvenancePickerCandidate,
} from '@/components/reports/sections/rupee-provenance-picker'

// reporting-blueprint.md §3 E-05 -- Rupee provenance trace. "Pick any rupee
// and follow it live: budget head -> allocation -> entry -> the bill image ->
// the line item -> the item family -> the benchmark. This is the demo that
// wins the meeting." §6 fix #4: every figure is a link.
//
// A server-rendered drill keyed on `?trace_entry_id=<id>` (resolved into
// `chain` by the loader). The picker child only writes the URL param.
//
// NOTE on the deep links below: they follow the same `/entries?<dim>_id=<id>`
// shape every other report section in this app uses. Those params are not yet
// read by the entries explorer (it parses `dept` / `bh` / `vendor`) -- see the
// loader header / the integration notes. Kept consistent with the siblings so
// one fix in entries-explorer lights them all up at once.

const OVER_BENCHMARK_WARN_PCT = 5
const BILL_GAP_WARN_PCT = 0.5
const BILL_GAP_BAD_PCT = 5

function tone(kind: 'good' | 'warn' | 'bad'): string {
  return kind === 'good'
    ? 'text-emerald-700 dark:text-emerald-300'
    : kind === 'warn'
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-red-700 dark:text-red-300'
}

function billGapTone(entryAmount: number | null, billTotal: number | null): 'good' | 'warn' | 'bad' {
  if (entryAmount == null || billTotal == null || entryAmount === 0) return 'warn'
  const pct = (Math.abs(entryAmount - billTotal) / Math.abs(entryAmount)) * 100
  if (pct <= BILL_GAP_WARN_PCT) return 'good'
  if (pct <= BILL_GAP_BAD_PCT) return 'warn'
  return 'bad'
}

function benchmarkTone(pct: number | null): 'good' | 'warn' | 'bad' | null {
  if (pct == null) return null
  if (pct > OVER_BENCHMARK_WARN_PCT) return 'bad'
  if (pct < -OVER_BENCHMARK_WARN_PCT) return 'good'
  return 'warn'
}

function billTotalOf(entry: RupeeProvenanceEntryRow): number | null {
  return entry.bill_total_verified ?? entry.bill_total_ocr ?? null
}

/** §6 fix #3 -- one computed sentence describing the current trace. */
export function rupeeProvenanceSentence(chain: RupeeProvenanceChain | null): string {
  if (!chain) {
    return 'Pick any entry to follow its rupees from budget head through allocation, the bill, each line item and the item-family rate benchmark.'
  }
  const { entry, lines, allocation } = chain
  const classified = lines.filter((l) => l.item_family_id != null).length
  const benchmarked = lines.filter((l) => l.benchmark_median_rate != null).length
  const vendor = entry.vendor_display_name ?? 'an unnamed vendor'
  const head = entry.budget_head_label ?? 'no budget head on file'
  const approvedPart =
    allocation && allocation.approvedAmount != null
      ? `, against an approved allocation of ${formatINRCompact(allocation.approvedAmount)}`
      : ''
  const billPart = entry.has_bill_image
    ? `Its bill carries ${formatNumber(entry.line_item_count)} line item${entry.line_item_count === 1 ? '' : 's'}`
    : 'No bill is attached yet'
  const classifyPart =
    lines.length === 0
      ? '.'
      : `, ${formatNumber(classified)} classified to an item family and ${formatNumber(benchmarked)} with a rate benchmark to compare against.`
  return `${formatINRCompact(entry.entry_amount)} on ${entry.ubbl_number} (${vendor}) sits under budget head "${head}"${approvedPart}. ${billPart}${classifyPart}`
}

function linkClass(): string {
  return 'text-primary underline-offset-2 hover:underline'
}

function Step({
  index,
  title,
  isLast,
  children,
}: {
  index: number
  title: string
  isLast?: boolean
  children: ReactNode
}) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <div className="flex flex-col items-center">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-medium tabular-nums text-muted-foreground">
          {index}
        </span>
        {!isLast && <span className="mt-1 w-px flex-1 bg-border" aria-hidden="true" />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
        <div className="flex flex-col gap-1 text-sm text-foreground">{children}</div>
      </div>
    </li>
  )
}

function toCandidate(row: RupeeProvenanceEntryRow): RupeeProvenancePickerCandidate {
  const bits = [row.ubbl_number, row.vendor_display_name ?? '—', formatDate(row.entry_date)]
  return { id: row.entry_id, label: bits.join(' · '), amount: row.entry_amount }
}

const LINE_COLUMNS: DataTableColumn<RupeeProvenanceLineRow>[] = [
  { key: 'n', header: '#', align: 'right', render: (l) => formatNumber(l.line_number) },
  { key: 'desc', header: 'Description', render: (l) => l.description ?? '—' },
  {
    key: 'qty',
    header: 'Qty × unit',
    render: (l) =>
      l.quantity == null ? '—' : `${formatNumber(l.quantity)}${l.unit ? ` ${l.unit}` : ''}`,
  },
  { key: 'rate', header: 'Net rate', align: 'right', render: (l) => formatINR(l.net_rate) },
  { key: 'amount', header: 'Line amount', align: 'right', render: (l) => formatINR(l.line_amount) },
  { key: 'family', header: 'Item family', render: (l) => l.item_family_label ?? 'Not classified' },
  {
    key: 'bench',
    header: 'Benchmark median',
    align: 'right',
    render: (l) => (l.benchmark_median_rate == null ? '—' : formatINR(l.benchmark_median_rate)),
  },
  {
    key: 'delta',
    header: '± vs benchmark',
    align: 'right',
    render: (l) => {
      const t = benchmarkTone(l.rate_vs_benchmark_pct)
      if (t == null) return '—'
      const sign = (l.rate_vs_benchmark_pct ?? 0) > 0 ? '+' : ''
      return <span className={tone(t)}>{`${sign}${formatPercent(l.rate_vs_benchmark_pct)}`}</span>
    },
  },
]

function ChainView({ chain }: { chain: RupeeProvenanceChain }) {
  const { entry, lines, linesError, allocation, allocationError } = chain
  const billTotal = billTotalOf(entry)
  const gap = entry.entry_amount != null && billTotal != null ? entry.entry_amount - billTotal : null
  const gapKind = billGapTone(entry.entry_amount, billTotal)

  const classifiedFamilies = new Map<number, string>()
  for (const l of lines) {
    if (l.item_family_id != null) classifiedFamilies.set(l.item_family_id, l.item_family_label ?? `#${l.item_family_id}`)
  }
  const benchmarked = lines.filter((l) => l.benchmark_median_rate != null)

  const lineCsv = toCsv(lines, [
    { header: 'Line', value: (l) => l.line_number },
    { header: 'Description', value: (l) => l.description },
    { header: 'HSN/SAC', value: (l) => l.hsn_sac },
    { header: 'Quantity', value: (l) => l.quantity },
    { header: 'Unit', value: (l) => l.unit },
    { header: 'Net rate', value: (l) => l.net_rate },
    { header: 'Line amount', value: (l) => l.line_amount },
    { header: 'Discount note', value: (l) => l.discount_note },
    { header: 'Item family', value: (l) => l.item_family_label },
    { header: 'Benchmark median rate', value: (l) => l.benchmark_median_rate },
    { header: 'Benchmark observations', value: (l) => l.benchmark_observation_count },
    { header: '% vs benchmark', value: (l) => l.rate_vs_benchmark_pct },
  ])

  return (
    <ol className="flex flex-col">
      <Step index={1} title="Budget category">
        {entry.budget_category_id != null ? (
          <Link href={`/entries?cost_center_id=${entry.budget_category_id}`} className={linkClass()}>
            {entry.budget_category_label ?? `#${entry.budget_category_id}`}
          </Link>
        ) : (
          <span className="text-muted-foreground">
            No budget category assigned{entry.budget_head_short_label ? ` (bill bracket: ${entry.budget_head_short_label})` : ''}
          </span>
        )}
      </Step>

      <Step index={2} title="Budget head + allocation">
        {entry.budget_head_id != null ? (
          <Link href={`/entries?budget_head_id=${entry.budget_head_id}`} className={linkClass()}>
            {entry.budget_head_label ?? `#${entry.budget_head_id}`}
          </Link>
        ) : (
          <span className="text-muted-foreground">No budget head on file</span>
        )}
        {allocationError ? (
          <p className="text-xs text-destructive">{allocationError}</p>
        ) : allocation ? (
          <p className="text-xs text-muted-foreground">
            Approved {formatINR(allocation.approvedAmount)}
            {allocation.asOf ? ` as of ${formatDate(allocation.asOf)}` : ''} · spent so far{' '}
            {formatINR(allocation.actualAmount)}
            {allocation.pctOfApproved != null ? ` (${formatPercent(allocation.pctOfApproved)} of approved)` : ''}
            {allocation.budgetStatusNote ? ` · ${allocation.budgetStatusNote}` : ''}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No allocation snapshot for this head in this event.</p>
        )}
      </Step>

      <Step index={3} title="Entry">
        <p>
          <Link href={`/entries/${entry.entry_id}`} className={linkClass()}>
            {entry.ubbl_number}
          </Link>{' '}
          <span className="font-semibold">{formatINR(entry.entry_amount)}</span> · {humanizeCode(entry.entry_type)} ·{' '}
          {formatDate(entry.entry_date)}
          {entry.invoice_number ? ` · invoice ${entry.invoice_number}` : ''}
        </p>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {entry.vendor_id != null && (
            <Link href={`/entries?vendor_id=${entry.vendor_id}`} className={linkClass()}>
              {entry.vendor_display_name ?? `Vendor #${entry.vendor_id}`}
            </Link>
          )}
          {entry.department_id != null && (
            <Link href={`/entries?department_id=${entry.department_id}`} className={linkClass()}>
              {entry.department_name ?? `Department #${entry.department_id}`}
            </Link>
          )}
          {entry.sub_department_name && <span>{entry.sub_department_name}</span>}
          {entry.admin_head_name && <span>{entry.admin_head_name}</span>}
          {entry.zone_id != null && (
            <Link href={`/entries?zone_id=${entry.zone_id}`} className={linkClass()}>
              {entry.zone_name ?? `Zone #${entry.zone_id}`}
            </Link>
          )}
        </p>
      </Step>

      <Step index={4} title="Bill">
        {entry.has_bill_image ? (
          <>
            <p>
              {entry.instrument_type ? INSTRUMENT_TYPE_LABELS[entry.instrument_type] ?? humanizeCode(entry.instrument_type) : 'Instrument type not set'}
              {entry.bill_verified_at ? ` · verified ${formatDate(entry.bill_verified_at)}` : ' · not yet verified'}
            </p>
            <p className="text-xs text-muted-foreground">
              Bill total {formatINR(billTotal)}
              {gap != null && (
                <>
                  {' · '}
                  <span className={tone(gapKind)}>
                    {gap === 0 ? 'matches the entry' : `${gap > 0 ? '+' : '−'}${formatINR(Math.abs(gap))} vs the entry`}
                  </span>
                </>
              )}
            </p>
            <p>
              <Link href={`/entries/${entry.entry_id}`} className={linkClass()}>
                Open the bill on the entry
              </Link>
            </p>
          </>
        ) : (
          <span className="text-muted-foreground">No bill is attached to this entry.</span>
        )}
      </Step>

      <Step index={5} title="Line items">
        {linesError ? (
          <p className="text-xs text-destructive">{linesError}</p>
        ) : lines.length === 0 ? (
          <span className="text-muted-foreground">
            {entry.has_bill_image
              ? 'The bill is attached but no line items have been extracted yet.'
              : 'No bill, so no line items.'}
          </span>
        ) : (
          <div className="flex flex-col gap-2">
            <DataTable
              columns={LINE_COLUMNS}
              rows={lines}
              getRowKey={(l) => l.line_item_id}
              emptyTitle="No line items"
            />
            <p className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-600 dark:bg-emerald-500" /> Below benchmark
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-amber-500 dark:bg-amber-400" /> Within ±{OVER_BENCHMARK_WARN_PCT}%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-red-600 dark:bg-red-500" /> Above benchmark
              </span>
            </p>
            <ExportCsvButton filename={`rupee-provenance-${entry.ubbl_number}-lines.csv`} rowCount={lines.length} csv={lineCsv} />
          </div>
        )}
      </Step>

      <Step index={6} title="Item family & benchmark" isLast>
        {classifiedFamilies.size === 0 ? (
          <span className="text-muted-foreground">
            None of these line items are classified against the item catalogue yet, so there is no benchmark to compare
            against. This fills in as the catalogue is confirmed in /catalog.
          </span>
        ) : (
          <>
            <p className="flex flex-wrap gap-x-3 gap-y-1">
              {[...classifiedFamilies.values()].map((label) => (
                <span key={label} className="rounded-full border border-border px-2 py-0.5 text-xs">
                  {label}
                </span>
              ))}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatNumber(benchmarked.length)} of {formatNumber(lines.length)} line item
              {lines.length === 1 ? '' : 's'} could be priced against a family + unit benchmark for this event.
            </p>
          </>
        )}
      </Step>
    </ol>
  )
}

export function RupeeProvenanceSection({
  candidates,
  candidatesError,
  chain,
  traceEntryId,
}: {
  candidates: RupeeProvenanceEntryRow[]
  candidatesError: string | null
  chain: RupeeProvenanceChain | null
  traceEntryId: number | null
}) {
  const pickerCandidates = candidates.map(toCandidate)
  const selectedNotFound = traceEntryId != null && chain == null

  return (
    <ReportSection
      id="rupee-provenance"
      title="Rupee provenance trace"
      description="Pick any rupee and follow it live: budget category → budget head → approved allocation → the entry → its bill → each line item → the item family → the rate benchmark. Every step links to the entries behind it."
    >
      {candidatesError ? (
        <EmptyState title="Couldn't load the entry list" description={candidatesError} />
      ) : candidates.length === 0 && chain == null ? (
        <EmptyState
          title="No entries in this event yet"
          description="The trace fills in once entries are imported for the selected event."
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{rupeeProvenanceSentence(chain)}</p>
          <RupeeProvenancePicker candidates={pickerCandidates} selectedId={traceEntryId} />
          {selectedNotFound && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Entry #{traceEntryId} isn&apos;t visible to you or isn&apos;t in this event — pick another above.
            </p>
          )}
          {chain && <ChainView chain={chain} />}
        </>
      )}
    </ReportSection>
  )
}
