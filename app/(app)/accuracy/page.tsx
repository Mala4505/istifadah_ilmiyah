import { subDays, startOfISOWeek, format } from 'date-fns'
import { Card, CardContent } from '@/components/ui/card'
import { requireAdmin, type AdminGate } from '@/lib/export/auth'
import { createClient } from '@/lib/supabase/server'
import { ReportSection } from '@/components/reports/report-section'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { EmptyState } from '@/components/reports/empty-state'
import { toCsv } from '@/lib/reports/csv'
import { formatDate, formatNumber, formatPercent } from '@/lib/reports/format'

/**
 * /accuracy — Screen 13 (MASTER-PLAN §5 row 13, §9.2). Admin-only. The
 * "correction log" discovery mechanism, distinct from and complementary to
 * the `npm run score` gold-set harness (test/score.ts) — see §9's table for
 * why neither substitutes for the other. Reads `v_extraction_correction`
 * (20260808000028_reporting_views.sql, untouched by the later
 * 20260811000004 rename pass) joined against `document_extraction.verified_at`
 * for the time-window denominators the view alone can't give you: the view
 * only contains rows where ocr_value differs from verified_value, so the
 * *agreement* rate needs the total verified-document count as the
 * denominator, which only the base table has.
 *
 * Line-item-level correction data (§9.2's "same shape over
 * document_extraction_line_item, plus a line_count comparison") is NOT in
 * the current migrations — only the header-field view exists. This screen
 * covers header fields only; line-item accuracy is a gap, not an omission.
 */
export const dynamic = 'force-dynamic'

const ROW_CAP = 5000 // safety cap; document volume is bounded by physical invoice count (§0)

const FIELDS = [
  { key: 'vendor_name', label: 'Vendor name' },
  { key: 'invoice_number', label: 'Invoice number' },
  { key: 'invoice_date', label: 'Invoice date' },
  { key: 'subtotal', label: 'Subtotal' },
  { key: 'tax_amount', label: 'Tax amount' },
  { key: 'total_amount', label: 'Total amount' },
  { key: 'vendor_gstin', label: 'Vendor GSTIN' },
] as const

type VerifiedDocRow = {
  id: number
  verified_at: string
}

type CorrectionRow = {
  id: number
  source_document_id: number
  model: string | null
  run_reason: string | null
  verified_at: string
  verified_by: string | null
  field: string
  ocr_value: string | null
  verified_value: string | null
}

async function loadAccuracyData() {
  const supabase = await createClient()

  const [verifiedRes, correctionRes] = await Promise.all([
    supabase
      .from('document_extraction')
      .select('id, verified_at')
      .not('verified_at', 'is', null)
      .order('verified_at', { ascending: false })
      .limit(ROW_CAP)
      .returns<VerifiedDocRow[]>(),
    supabase
      .from('v_extraction_correction')
      .select('id, source_document_id, model, run_reason, verified_at, verified_by, field, ocr_value, verified_value')
      .order('verified_at', { ascending: false })
      .limit(ROW_CAP)
      .returns<CorrectionRow[]>(),
  ])

  return {
    verifiedRows: verifiedRes.data ?? [],
    correctionRows: correctionRes.data ?? [],
    errors: {
      verified: verifiedRes.error?.message ?? null,
      correction: correctionRes.error?.message ?? null,
    },
  }
}

function withinWindow(verifiedAt: string, days: number | null): boolean {
  if (days === null) return true
  return new Date(verifiedAt) >= subDays(new Date(), days)
}

type WindowStats = { totalVerified: number; correctionsByField: Map<string, number> }

function statsForWindow(verifiedRows: VerifiedDocRow[], correctionRows: CorrectionRow[], days: number | null): WindowStats {
  const totalVerified = verifiedRows.filter((r) => withinWindow(r.verified_at, days)).length
  const correctionsByField = new Map<string, number>()
  for (const c of correctionRows) {
    if (!withinWindow(c.verified_at, days)) continue
    correctionsByField.set(c.field, (correctionsByField.get(c.field) ?? 0) + 1)
  }
  return { totalVerified, correctionsByField }
}

type WindowCell = { rate: number | null; total: number; corrections: number }
type FieldAgreementRow = { field: string; label: string; w7: WindowCell; w30: WindowCell; wAll: WindowCell }

function cellFor(stats: WindowStats, fieldKey: string): WindowCell {
  const corrections = stats.correctionsByField.get(fieldKey) ?? 0
  const total = stats.totalVerified
  const rate = total === 0 ? null : ((total - corrections) / total) * 100
  return { rate, total, corrections }
}

function buildFieldAgreement(verifiedRows: VerifiedDocRow[], correctionRows: CorrectionRow[]): FieldAgreementRow[] {
  const w7 = statsForWindow(verifiedRows, correctionRows, 7)
  const w30 = statsForWindow(verifiedRows, correctionRows, 30)
  const wAll = statsForWindow(verifiedRows, correctionRows, null)

  return FIELDS.map((f) => ({
    field: f.key,
    label: f.label,
    w7: cellFor(w7, f.key),
    w30: cellFor(w30, f.key),
    wAll: cellFor(wAll, f.key),
  })).sort((a, b) => {
    // Worst all-time agreement first -- surfaces the fields most worth a tuning pass.
    if (a.wAll.rate === null && b.wAll.rate === null) return 0
    if (a.wAll.rate === null) return 1
    if (b.wAll.rate === null) return -1
    return a.wAll.rate - b.wAll.rate
  })
}

type TrendBucket = { weekStart: string; verifiedDocs: number; corrections: number; agreementRate: number | null }

function buildTrend(verifiedRows: VerifiedDocRow[], correctionRows: CorrectionRow[]): TrendBucket[] {
  const bucketOf = (isoDate: string) => format(startOfISOWeek(new Date(isoDate)), 'yyyy-MM-dd')

  const verifiedByBucket = new Map<string, number>()
  for (const r of verifiedRows) {
    const b = bucketOf(r.verified_at)
    verifiedByBucket.set(b, (verifiedByBucket.get(b) ?? 0) + 1)
  }

  const correctionsByBucket = new Map<string, number>()
  for (const c of correctionRows) {
    const b = bucketOf(c.verified_at)
    correctionsByBucket.set(b, (correctionsByBucket.get(b) ?? 0) + 1)
  }

  return Array.from(verifiedByBucket.keys())
    .sort()
    .map((weekStart) => {
      const verifiedDocs = verifiedByBucket.get(weekStart) ?? 0
      const corrections = correctionsByBucket.get(weekStart) ?? 0
      const totalOpportunities = verifiedDocs * FIELDS.length
      const agreementRate = totalOpportunities === 0 ? null : ((totalOpportunities - corrections) / totalOpportunities) * 100
      return { weekStart, verifiedDocs, corrections, agreementRate }
    })
}

type PatternRow = {
  key: string
  field: string
  fieldLabel: string
  ocrValue: string | null
  verifiedValue: string | null
  diffShape: 'truncation' | 'different value'
  count: number
}

function normalize(v: string | null): string {
  return (v ?? '').trim().toLowerCase()
}

/**
 * Deliberately simple, per §9.2's instruction not to over-engineer a diffing
 * algorithm: "truncation" when one value (case-folded, trimmed) is a
 * substring-prefix of the other, "different value" otherwise. Grouping is
 * exact (field, normalized ocr_value, normalized verified_value) — a
 * straightforward group-and-count, not fuzzy clustering.
 */
function classifyDiff(ocrValue: string | null, verifiedValue: string | null): 'truncation' | 'different value' {
  const a = normalize(ocrValue)
  const b = normalize(verifiedValue)
  if (a === '' || b === '' || a === b) return 'different value'
  return a.startsWith(b) || b.startsWith(a) ? 'truncation' : 'different value'
}

function buildPatterns(correctionRows: CorrectionRow[]): PatternRow[] {
  const fieldLabels = new Map<string, string>(FIELDS.map((f) => [f.key, f.label]))
  const groups = new Map<string, { field: string; ocrValue: string | null; verifiedValue: string | null; count: number }>()

  for (const c of correctionRows) {
    const key = `${c.field}||${normalize(c.ocr_value)}||${normalize(c.verified_value)}`
    const existing = groups.get(key)
    if (existing) {
      existing.count += 1
    } else {
      groups.set(key, { field: c.field, ocrValue: c.ocr_value, verifiedValue: c.verified_value, count: 1 })
    }
  }

  return Array.from(groups.entries())
    .map(([key, g]) => ({
      key,
      field: g.field,
      fieldLabel: fieldLabels.get(g.field) ?? g.field,
      ocrValue: g.ocrValue,
      verifiedValue: g.verifiedValue,
      diffShape: classifyDiff(g.ocrValue, g.verifiedValue),
      count: g.count,
    }))
    .sort((a, b) => b.count - a.count)
}

const SECTIONS = [
  { id: 'field-agreement', label: 'Per-field Agreement' },
  { id: 'trend', label: 'Trend' },
  { id: 'correction-patterns', label: 'Top Correction Patterns' },
] as const

export default async function AccuracyPage() {
  const gate = await requireAdmin()
  if (!gate.ok) {
    return <PermissionDeniedState reason={gate.reason} />
  }

  const data = await loadAccuracyData()
  const hasAnyVerified = data.verifiedRows.length > 0
  const loadError = data.errors.verified ?? data.errors.correction

  const fieldRows = buildFieldAgreement(data.verifiedRows, data.correctionRows)
  const trendBuckets = buildTrend(data.verifiedRows, data.correctionRows)
  const patternRows = buildPatterns(data.correctionRows)

  const fieldBarItems: BarListItem[] = fieldRows
    .filter((r) => r.wAll.total > 0)
    .map((r) => ({
      key: r.field,
      label: r.label,
      value: r.wAll.rate ?? 0,
      note: `n=${formatNumber(r.wAll.total)}`,
    }))

  const trendBarItems: BarListItem[] = trendBuckets.slice(-16).map((b) => ({
    key: b.weekStart,
    label: `Week of ${formatDate(b.weekStart)}`,
    value: b.agreementRate ?? 0,
    note: `n=${formatNumber(b.verifiedDocs)}`,
  }))

  const fieldColumns: DataTableColumn<FieldAgreementRow>[] = [
    { key: 'field', header: 'Field', render: (r) => r.label },
    { key: 'w7pct', header: '7d Agreement', align: 'right', render: (r) => formatPercent(r.w7.rate) },
    { key: 'w7n', header: '7d n', align: 'right', render: (r) => formatNumber(r.w7.total) },
    { key: 'w30pct', header: '30d Agreement', align: 'right', render: (r) => formatPercent(r.w30.rate) },
    { key: 'w30n', header: '30d n', align: 'right', render: (r) => formatNumber(r.w30.total) },
    { key: 'wAllpct', header: 'All-time Agreement', align: 'right', render: (r) => formatPercent(r.wAll.rate) },
    { key: 'wAlln', header: 'All-time n', align: 'right', render: (r) => formatNumber(r.wAll.total) },
  ]

  const trendColumns: DataTableColumn<TrendBucket>[] = [
    { key: 'week', header: 'Week starting', render: (r) => formatDate(r.weekStart) },
    { key: 'verified', header: 'Verified documents', align: 'right', render: (r) => formatNumber(r.verifiedDocs) },
    { key: 'corrections', header: 'Corrections', align: 'right', render: (r) => formatNumber(r.corrections) },
    { key: 'rate', header: 'Agreement %', align: 'right', render: (r) => formatPercent(r.agreementRate) },
  ]

  const patternColumns: DataTableColumn<PatternRow>[] = [
    { key: 'field', header: 'Field', render: (r) => r.fieldLabel },
    { key: 'ocr', header: 'OCR value', render: (r) => r.ocrValue ?? '—' },
    { key: 'verified', header: 'Verified value', render: (r) => r.verifiedValue ?? '—' },
    { key: 'shape', header: 'Diff shape', render: (r) => r.diffShape },
    { key: 'count', header: 'Count', align: 'right', render: (r) => formatNumber(r.count) },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Accuracy</h1>
        <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent-foreground">
          Phase 1B · Day 5
        </span>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Per-field agreement rate over 7/30/all-days windows, a weekly trend, and the most common
        correction patterns — the correction-log discovery mechanism (§9.2), distinct from and
        complementary to the gold-set regression harness (<code>npm run score</code>). Anchoring
        makes this optimistic (§9.2.1): a reviewer shown a pre-filled wrong value accepts it more
        often than they would type it unprompted, so measured agreement drifts above true accuracy.
        Header fields only — line-item corrections are not in the current migrations.
      </p>

      <nav className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border pb-3 text-xs">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="text-muted-foreground hover:text-foreground hover:underline">
            {s.label}
          </a>
        ))}
      </nav>

      {loadError ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">Could not load accuracy data: {loadError}</p>
          </CardContent>
        </Card>
      ) : !hasAnyVerified ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              title="No corrections recorded yet"
              description="The accuracy report populates as reviewers verify documents through the review queue."
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <ReportSection
            id="field-agreement"
            title="Per-field agreement rate"
            description="Fraction of verified extractions where the OCR value matched the reviewer-verified value, per field. Sorted worst-first."
            action={
              <ExportCsvButton
                filename="accuracy-field-agreement.csv"
                rowCount={fieldRows.length}
                csv={toCsv(fieldRows, [
                  { header: 'Field', value: (r) => r.label },
                  { header: '7d Agreement %', value: (r) => r.w7.rate },
                  { header: '7d n', value: (r) => r.w7.total },
                  { header: '7d Corrections', value: (r) => r.w7.corrections },
                  { header: '30d Agreement %', value: (r) => r.w30.rate },
                  { header: '30d n', value: (r) => r.w30.total },
                  { header: '30d Corrections', value: (r) => r.w30.corrections },
                  { header: 'All-time Agreement %', value: (r) => r.wAll.rate },
                  { header: 'All-time n', value: (r) => r.wAll.total },
                  { header: 'All-time Corrections', value: (r) => r.wAll.corrections },
                ])}
              />
            }
          >
            <BarList items={fieldBarItems} max={100} valueFormatter={(v) => formatPercent(v)} />
            <DataTable columns={fieldColumns} rows={fieldRows} getRowKey={(r) => r.field} />
          </ReportSection>

          <ReportSection
            id="trend"
            title="Agreement rate trend"
            description="Weekly agreement rate across all fields combined (last 16 weeks shown; export has the full history)."
            action={
              <ExportCsvButton
                filename="accuracy-trend.csv"
                rowCount={trendBuckets.length}
                csv={toCsv(trendBuckets, [
                  { header: 'Week starting', value: (r) => r.weekStart },
                  { header: 'Verified documents', value: (r) => r.verifiedDocs },
                  { header: 'Corrections', value: (r) => r.corrections },
                  { header: 'Agreement %', value: (r) => r.agreementRate },
                ])}
              />
            }
          >
            <BarList items={trendBarItems} max={100} valueFormatter={(v) => formatPercent(v)} />
            <DataTable columns={trendColumns} rows={trendBuckets} getRowKey={(r) => r.weekStart} />
          </ReportSection>

          <ReportSection
            id="correction-patterns"
            title="Top correction patterns"
            description={
              patternRows.length === 0
                ? 'No corrections recorded — every verified field matched its OCR value.'
                : 'Grouped by (field, OCR value, verified value), case-folded and trimmed. "Truncation" means one value is a substring-prefix of the other; everything else is "different value". Not fuzzy clustering.'
            }
            action={
              <ExportCsvButton
                filename="accuracy-correction-patterns.csv"
                rowCount={patternRows.length}
                csv={toCsv(patternRows, [
                  { header: 'Field', value: (r) => r.fieldLabel },
                  { header: 'OCR value', value: (r) => r.ocrValue },
                  { header: 'Verified value', value: (r) => r.verifiedValue },
                  { header: 'Diff shape', value: (r) => r.diffShape },
                  { header: 'Count', value: (r) => r.count },
                ])}
              />
            }
          >
            <DataTable
              columns={patternColumns}
              rows={patternRows.slice(0, 50)}
              getRowKey={(r) => r.key}
              emptyTitle="No correction patterns"
              emptyDescription="Every verified field matched its OCR value in the loaded sample."
            />
          </ReportSection>
        </>
      )}
    </div>
  )
}

function PermissionDeniedState({ reason }: { reason: Extract<AdminGate, { ok: false }>['reason'] }) {
  const copy: Record<string, { title: string; body: string }> = {
    signed_out: {
      title: 'Sign in required',
      body: 'You need to sign in to view the accuracy screen.',
    },
    inactive: {
      title: 'Your account is pending activation',
      body: 'An admin needs to activate your account before you can use the Hub.',
    },
    not_admin: {
      title: 'Admins only',
      body: 'The accuracy report is admin-only (MASTER-PLAN §5 row 13) — its export is what feeds prompt tuning decisions. Ask an admin to run this, or ask to be granted the admin role if you should have access.',
    },
  }
  const { title, body } = copy[reason] ?? copy.not_admin!

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Accuracy</h1>
      <Card>
        <CardContent className="flex flex-col gap-2 pt-6">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">{body}</p>
        </CardContent>
      </Card>
    </div>
  )
}
