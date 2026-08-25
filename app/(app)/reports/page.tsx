import { friendlyDataError } from '@/lib/friendly-error'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { ReportSection } from '@/components/reports/report-section'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { toCsv } from '@/lib/reports/csv'
import { SeverityBadge, AgeBucketBadge } from '@/components/reports/severity-badge'
import { EmptyState } from '@/components/reports/empty-state'
import {
  formatDate,
  formatDateTime,
  formatINR,
  formatINRCompact,
  formatNumber,
  formatPercent,
  humanizeCode,
} from '@/lib/reports/format'
import { RATE_BENCHMARK_MIN_OBSERVATIONS, RATE_BENCHMARK_MIN_VENDORS } from '@/lib/analytics/thresholds'
import { loadHeroMetrics } from '@/lib/reports/hero-metrics'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { TrendChart } from '@/components/reports/charts/trend-chart'
import { DonutChart, type DonutSegment } from '@/components/reports/charts/donut-chart'
import { FunnelChart } from '@/components/reports/charts/funnel-chart'
import { ORDINAL_RAMP } from '@/components/reports/charts/ordinal-ramp'

// Screen 10 — Reports (MASTER-PLAN §5, day 6). Every section reads from a
// §10.2 reporting view and carries its own CSV export. Charts are plain
// CSS bar lists (dataviz skill's no-dependency option) rather than a new
// charting library — the data here is "rank N things by ₹", which a bar
// list communicates as well as a bar chart would.
//
// Absorbs the former /analytics screen (Phase 2 analytics engine —
// MASTER-PLAN §14 Phase 2; item catalog, flags-run, rate comparison) as its
// last four sections, following the nav-simplification merge: one
// one-page-many-sections screen instead of two near-duplicate ones. Every
// row in those four sections still originates from flags-run
// (lib/jobs/handlers/flags-run.ts), which re-queues itself every 15 minutes
// — see that file's header comment for why a whole-corpus sweep has no
// natural trigger event and self-schedules instead. A flag confirmed or
// dismissed here is never silently reopened by a later sweep (the upsert in
// 20260814000004 leaves status/resolved_* alone).
export const dynamic = 'force-dynamic'

const ROW_CAP = 1000 // safety cap on entry-level views at 1k-10k entry volume (§0)

type BudgetVsActualRow = {
  budget_head_id: number
  raw_label: string
  short_label: string | null
  department_id: number | null
  approved_amount: number | null
  utilised_amount: number | null
  balance_amount: number | null
  actual_amount: number | null
  entry_count: number
  pct_of_approved: number | null
  budget_status_note: string | null
}

type DepartmentBudgetVsActualRow = {
  department_id: number
  department_name: string
  as_of: string | null
  budget_amount: number | null
  actual_amount: number | null
  entry_count: number
  pct_of_budget: number | null
  budget_status_note: string | null
}

type VendorSpendRow = {
  vendor_id: number
  display_name: string
  entry_count: number
  total_amount: number | null
  first_entry_date: string | null
  last_entry_date: string | null
  entries_with_documents: number
  document_coverage_pct: number | null
}

type ZoneSpendRow = {
  zone_id: number | null
  zone_name: string
  zone_number: number | null
  department_id: number | null
  entry_count: number
  total_amount: number | null
}

type HubAgeingRow = {
  entry_id: number
  department_id: number | null
  ubbl_number: string
  hub_status_code: string
  hub_status_label: string
  hub_status_changed_at: string | null
  days_in_status: number
  age_bucket: '0-2' | '3-7' | '8+'
}

type OpenIssueRow = {
  source_table: string
  id: number
  entry_id: number | null
  issue_type: string
  severity: string
  amount_at_risk: number | null
  description: string | null
  status: string
  created_at: string
}

type ComplianceRow = {
  id: number
  flag_type: string
  severity: string
  description: string | null
  amount_at_risk: number | null
  status: string
  entry_id: number | null
  vendor_id: number | null
  vendor_display_name: string | null
  department_id: number | null
  department_name: string | null
  created_at: string
  last_detected_at: string
  related_entry_ids: number[] | null
}

type VendorConcentrationRow = {
  vendor_id: number
  display_name: string
  is_confirmed: boolean
  entry_count: number
  total_amount: number | null
  open_flag_count: number
  open_flag_amount_at_risk: number | null
  pct_of_total_spend: number | null
}

// Phase 5 §5.2 (docs/pre-deploy-findings-and-plan.md): "Vendor spend" and
// "Vendor concentration" used to be two sections ranking the same vendors by
// the same spend, differing only in trailing columns. Merged into one row
// shape that carries every column from both — built by joining
// v_vendor_spend (entry-level detail: first/last entry, doc coverage) with
// v_vendor_concentration (corpus-share detail: % of total, open-flag
// exposure) on vendor_id, keyed off the spend rows since those are the ones
// already filtered to entry_count > 0.
type MergedVendorRow = VendorSpendRow & {
  pct_of_total_spend: number | null
  open_flag_count: number
  open_flag_amount_at_risk: number | null
}

type SpendByFamilyRow = {
  item_family_id: number
  family_key: string
  label: string
  default_unit: string | null
  is_confirmed: boolean
  total_spend: number
  observation_count: number
  vendor_count: number
}

type RateBenchmarkRow = {
  item_family_id: number
  family_key: string
  family_label: string
  unit_normalized: string | null
  median_rate: number | null
  observation_count: number
  vendor_count: number
  min_rate: number | null
  max_rate: number | null
}

async function loadReportsData() {
  const supabase = await createClient()

  // Phase 6 Step 2 (docs/event-scoping-and-review-fixes-plan.md §1): every
  // report below reads an aggregate view that now exposes `event_id` as a
  // plain output column (20260822000007) rather than baking the filter into
  // the view itself, matching Stream A's v_review_queue precedent -- the
  // views stay reusable for a future cross-event comparison mode (§1.6,
  // explicitly out of scope for this pass). Filtering happens here, at the
  // query site, against whichever event the active_event_id cookie
  // resolves to (current event by default).
  const selectedEvent = await getSelectedEvent(supabase)
  const eventId = selectedEvent?.id ?? null

  const [budgetRes, deptBudgetRes, vendorRes, zoneRes, ageingRes, issuesRes] = await Promise.all([
    supabase
      .from('v_budget_vs_actual')
      .select(
        'budget_head_id, raw_label, short_label, department_id, approved_amount, utilised_amount, balance_amount, actual_amount, entry_count, pct_of_approved, budget_status_note'
      )
      .eq('event_id', eventId)
      .order('actual_amount', { ascending: false, nullsFirst: false })
      .returns<BudgetVsActualRow[]>(),
    supabase
      .from('v_department_budget_vs_actual')
      .select(
        'department_id, department_name, as_of, budget_amount, actual_amount, entry_count, pct_of_budget, budget_status_note'
      )
      .eq('event_id', eventId)
      .order('actual_amount', { ascending: false, nullsFirst: false })
      .returns<DepartmentBudgetVsActualRow[]>(),
    supabase
      .from('v_vendor_spend')
      .select(
        'vendor_id, display_name, entry_count, total_amount, first_entry_date, last_entry_date, entries_with_documents, document_coverage_pct'
      )
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<VendorSpendRow[]>(),
    supabase
      .from('v_zone_spend')
      .select('zone_id, zone_name, zone_number, department_id, entry_count, total_amount')
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .returns<ZoneSpendRow[]>(),
    supabase
      .from('v_hub_status_ageing')
      .select('entry_id, department_id, ubbl_number, hub_status_code, hub_status_label, hub_status_changed_at, days_in_status, age_bucket')
      .eq('event_id', eventId)
      .order('days_in_status', { ascending: false })
      .limit(ROW_CAP)
      .returns<HubAgeingRow[]>(),
    // Phase 0 §0.2: was `.eq('event_id', eventId)`, which silently dropped
    // every row whose event can't be resolved (document-/batch-level
    // exceptions with no traceable event, and vendor-level flags) — the same
    // class of bug that made the Exceptions queue, Dashboard and Reports
    // digest disagree by ~30x on the same backlog. Keep those rows
    // regardless of the active event, matching Dashboard and Exceptions.
    eventId === null
      ? supabase
          .from('v_open_issues')
          .select('source_table, id, entry_id, issue_type, severity, amount_at_risk, description, status, created_at')
          .limit(ROW_CAP)
          .returns<OpenIssueRow[]>()
      : supabase
          .from('v_open_issues')
          .select('source_table, id, entry_id, issue_type, severity, amount_at_risk, description, status, created_at')
          .or(`event_id.eq.${eventId},event_id.is.null`)
          .limit(ROW_CAP)
          .returns<OpenIssueRow[]>(),
  ])

  const vendorRows = (vendorRes.data ?? []).filter((r) => r.entry_count > 0)
  const ageingRows = ageingRes.data ?? []

  return {
    eventName: selectedEvent?.name ?? null,
    budgetRows: budgetRes.data ?? [],
    deptBudgetRows: deptBudgetRes.data ?? [],
    vendorRows,
    zoneRows: zoneRes.data ?? [],
    ageingRows,
    ageingBuckets: {
      '0-2': ageingRows.filter((r) => r.age_bucket === '0-2').length,
      '3-7': ageingRows.filter((r) => r.age_bucket === '3-7').length,
      '8+': ageingRows.filter((r) => r.age_bucket === '8+').length,
    },
    issueRows: issuesRes.data ?? [],
    errors: {
      budget: friendlyDataError(budgetRes.error, 'reports:budgetRes'),
      deptBudget: friendlyDataError(deptBudgetRes.error, 'reports:deptBudgetRes'),
      vendor: friendlyDataError(vendorRes.error, 'reports:vendorRes'),
      zone: friendlyDataError(zoneRes.error, 'reports:zoneRes'),
      ageing: friendlyDataError(ageingRes.error, 'reports:ageingRes'),
      issues: friendlyDataError(issuesRes.error, 'reports:issuesRes'),
    },
  }
}

async function loadAnalyticsData() {
  const supabase = await createClient()

  // Phase 5 (docs/pre-deploy-findings-and-plan.md §5): these four views
  // gained an `event_id` output column in 20260822000011, following the same
  // pattern as the other reporting views (20260822000007, see
  // loadReportsData above). Filter here at the query site against the same
  // active-event resolution the rest of the page uses, so the analytics
  // sections stop mixing every event's flags/vendors/families together.
  const selectedEvent = await getSelectedEvent(supabase)
  const eventId = selectedEvent?.id ?? null

  const [complianceRes, concentrationRes, familyRes, benchmarkRes] = await Promise.all([
    // v_compliance_summary is sourced straight from `flags` (one row per open
    // flag, no group-by) — a vendor-level flag with no entry_id (e.g. a
    // vendor_cluster splitting pattern) resolves to a null event_id, per
    // 20260822000011's header comment, "same as v_open_issues already
    // documents for that case." A plain `.eq('event_id', eventId)` would
    // silently drop those open findings whenever an event is selected —
    // exactly the Phase 0 §0.2 bug already fixed for v_open_issues above.
    // Reuse that same eventId-null-vs-not branch here instead.
    eventId === null
      ? supabase
          .from('v_compliance_summary')
          .select(
            'id, flag_type, severity, description, amount_at_risk, status, entry_id, vendor_id, vendor_display_name, department_id, department_name, created_at, last_detected_at, related_entry_ids'
          )
          .limit(ROW_CAP)
          .returns<ComplianceRow[]>()
      : supabase
          .from('v_compliance_summary')
          .select(
            'id, flag_type, severity, description, amount_at_risk, status, entry_id, vendor_id, vendor_display_name, department_id, department_name, created_at, last_detected_at, related_entry_ids'
          )
          .or(`event_id.eq.${eventId},event_id.is.null`)
          .limit(ROW_CAP)
          .returns<ComplianceRow[]>(),
    // v_vendor_concentration / v_spend_by_family / v_rate_benchmark are
    // per-dimension aggregates (vendor / item family / family+unit), not
    // row-level finding feeds — a plain `.eq('event_id', eventId)` here
    // matches the same pattern loadReportsData already uses for the other
    // entity-aggregate views (budget head, department, vendor spend, zone).
    // A dimension whose only observations can't be traced to any event (see
    // 20260822000011's header) simply won't surface under a specific event,
    // which is the same trade-off those other views already make.
    supabase
      .from('v_vendor_concentration')
      .select(
        'vendor_id, display_name, is_confirmed, entry_count, total_amount, open_flag_count, open_flag_amount_at_risk, pct_of_total_spend'
      )
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<VendorConcentrationRow[]>(),
    supabase
      .from('v_spend_by_family')
      .select('item_family_id, family_key, label, default_unit, is_confirmed, total_spend, observation_count, vendor_count')
      .eq('event_id', eventId)
      .order('total_spend', { ascending: false })
      .returns<SpendByFamilyRow[]>(),
    supabase
      .from('v_rate_benchmark')
      .select('item_family_id, family_key, family_label, unit_normalized, median_rate, observation_count, vendor_count, min_rate, max_rate')
      .eq('event_id', eventId)
      .order('observation_count', { ascending: false })
      .returns<RateBenchmarkRow[]>(),
  ])

  const vendorRows = (concentrationRes.data ?? []).filter((r) => (r.entry_count ?? 0) > 0)

  return {
    complianceRows: complianceRes.data ?? [],
    vendorRows,
    familyRows: familyRes.data ?? [],
    benchmarkRows: benchmarkRes.data ?? [],
    errors: {
      compliance: friendlyDataError(complianceRes.error, 'analytics:complianceRes'),
      concentration: friendlyDataError(concentrationRes.error, 'analytics:concentrationRes'),
      family: friendlyDataError(familyRes.error, 'analytics:familyRes'),
      benchmark: friendlyDataError(benchmarkRes.error, 'analytics:benchmarkRes'),
    },
  }
}

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'budget-vs-actual', label: 'Budget vs Actual' },
  { id: 'department-budget-vs-actual', label: 'Department Budget vs Actual' },
  { id: 'vendor-spend', label: 'Vendor Spend' },
  { id: 'zone-spend', label: 'Spend by Zone' },
  { id: 'hub-status-ageing', label: 'Hub-status Ageing' },
  { id: 'open-issues', label: 'Open Issues' },
  { id: 'compliance', label: 'Compliance & Leakage' },
  { id: 'spend-by-family', label: 'Spend by Item Family' },
  { id: 'rate-benchmark', label: 'Rate Benchmark' },
] as const

export default async function ReportsPage() {
  // One extra getSelectedEvent() round trip here, deliberately -- matches
  // this file's existing convention of each loader owning its own Supabase
  // client and resolving the active event itself (loadReportsData,
  // loadAnalyticsData) rather than threading a shared client/eventId through
  // props. loadHeroMetrics follows the same pattern, so it needs eventId
  // resolved at the call site.
  const eventSupabase = await createClient()
  const selectedEventForHero = await getSelectedEvent(eventSupabase)
  const [data, analyticsData, hero] = await Promise.all([
    loadReportsData(),
    loadAnalyticsData(),
    loadHeroMetrics(selectedEventForHero?.id ?? null),
  ])

  // ---- Overview band (hero KPIs, spend pace, hub-status mix, pipeline) ----

  function seriesDelta(series: number[]): number | null {
    if (series.length < 2) return null
    return series[series.length - 1]! - series[series.length - 2]!
  }
  function formatDeltaINR(delta: number | null): string | undefined {
    if (delta == null) return undefined
    const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±'
    return `${sign}${formatINRCompact(Math.abs(delta))} this week`
  }
  function formatDeltaCount(delta: number | null, noun: string): string | undefined {
    if (delta == null) return undefined
    const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±'
    return `${sign}${formatNumber(Math.abs(delta))} ${noun} this week`
  }

  const spendDelta = seriesDelta(hero.kpi.weeklySpendSeries)
  const entryDelta = seriesDelta(hero.kpi.weeklyEntrySeries)
  const riskDelta = seriesDelta(hero.kpi.weeklyAtRiskSeries)
  // No delta badge for "avg days to review": an empty week reduces to 0 in
  // this series (see hero-metrics.ts's own flagged judgment call), which
  // would misreport as "reviewed same-day" rather than "nothing reviewed
  // that week" -- showing a value+sparkline without a week-over-week claim
  // is the honest version until that ambiguity is resolved at the source.

  const hubStatusSegments: DonutSegment[] = hero.hubStatus.map((s, i) => ({
    key: s.key,
    label: s.label,
    value: s.value,
    colorClass: ORDINAL_RAMP[i % ORDINAL_RAMP.length]!.strokeClass,
  }))

  const spendTrendPoints = hero.spendTrend.map((p) => ({ label: p.weekLabel, actual: p.actual, target: p.target }))

  // Budget-vs-actual bar color: reserved status color, not the ordinal ramp
  // -- this encodes "over/near/within budget," a genuinely per-row status,
  // not a rank or a sequence position. No approved budget at all keeps the
  // default accent blue (there's no over/under signal to show).
  function budgetStatusColorClass(approved: number | null, actual: number | null): string | undefined {
    if (!approved || approved <= 0) return undefined
    const pct = ((actual ?? 0) / approved) * 100
    if (pct <= 95) return 'bg-emerald-600 dark:bg-emerald-500'
    if (pct <= 110) return 'bg-amber-500 dark:bg-amber-400'
    return 'bg-red-600 dark:bg-red-500'
  }

  const SEVERITY_DONUT_COLOR: Record<string, string> = {
    high: 'stroke-red-600 dark:stroke-red-400',
    medium: 'stroke-amber-500 dark:stroke-amber-400',
    low: 'stroke-muted-foreground',
  }
  function severitySegments(rows: { severity: string | null }[]): DonutSegment[] {
    const counts: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 0, low: 0 }
    for (const r of rows) {
      const k = r.severity === 'high' || r.severity === 'medium' ? r.severity : 'low'
      counts[k] += 1
    }
    return (['high', 'medium', 'low'] as const)
      .filter((k) => counts[k] > 0)
      .map((k) => ({
        key: k,
        label: k === 'high' ? 'High severity' : k === 'medium' ? 'Medium severity' : 'Low severity',
        value: counts[k],
        colorClass: SEVERITY_DONUT_COLOR[k]!,
      }))
  }
  const issueSeveritySegments = severitySegments(data.issueRows)
  const complianceSeveritySegments = severitySegments(analyticsData.complianceRows)

  const budgetBarItems: BarListItem[] = data.budgetRows
    .filter((r) => (r.actual_amount ?? 0) > 0)
    .slice(0, 12)
    .map((r) => ({
      key: r.budget_head_id,
      label: r.short_label ?? r.raw_label,
      value: r.actual_amount ?? 0,
      marker: r.approved_amount && r.approved_amount > 0 ? r.approved_amount : null,
      markerLabel: r.approved_amount ? `Approved: ${formatINR(r.approved_amount)}` : undefined,
      note: r.budget_status_note ?? undefined,
      colorClass: budgetStatusColorClass(r.approved_amount, r.actual_amount),
    }))

  // Phase 5 §5.1 (docs/pre-deploy-findings-and-plan.md): budget heads carry a
  // department_id but v_department_budget_vs_actual is the only view that
  // already resolves department names for the active event, so borrow its
  // rows as a lookup rather than adding a new query. A head whose department
  // has no department-level budget imported (or no department at all) falls
  // back to a numbered/"Unassigned" label rather than disappearing.
  const departmentNameById = new Map(data.deptBudgetRows.map((d) => [d.department_id, d.department_name]))
  const budgetDepartmentLabel = (departmentId: number | null) =>
    departmentId == null
      ? 'Unassigned'
      : (departmentNameById.get(departmentId) ?? `Department #${departmentId}`)

  // Group budget heads by department (then by actual spend within each
  // department) so the flat cross-department list becomes scannable — was
  // previously sorted by actual_amount alone with no department grouping.
  const budgetRowsGrouped = [...data.budgetRows].sort((a, b) => {
    const deptCompare = budgetDepartmentLabel(a.department_id).localeCompare(budgetDepartmentLabel(b.department_id))
    if (deptCompare !== 0) return deptCompare
    return (b.actual_amount ?? 0) - (a.actual_amount ?? 0)
  })

  const deptBudgetBarItems: BarListItem[] = data.deptBudgetRows
    .filter((r) => (r.actual_amount ?? 0) > 0)
    .slice(0, 12)
    .map((r) => ({
      key: r.department_id,
      label: r.department_name,
      value: r.actual_amount ?? 0,
      marker: r.budget_amount && r.budget_amount > 0 ? r.budget_amount : null,
      markerLabel: r.budget_amount ? `Budget: ${formatINR(r.budget_amount)}` : undefined,
      note: r.budget_status_note ?? undefined,
      colorClass: budgetStatusColorClass(r.budget_amount, r.actual_amount),
    }))

  // Phase 5 §5.2: join spend rows (data.vendorRows, already event-scoped)
  // with concentration rows (analyticsData.vendorRows, now event-scoped too
  // per this same pass) on vendor_id. Keyed off the spend side since that's
  // where entry-level detail (first/last entry, doc coverage) lives; a
  // vendor missing from the concentration side (should be rare — both views
  // filter to entry_count > 0 over the same event) just falls back to
  // null/0 for the concentration-only columns instead of being dropped.
  const concentrationByVendorId = new Map(analyticsData.vendorRows.map((r) => [r.vendor_id, r]))
  const mergedVendorRows: MergedVendorRow[] = data.vendorRows.map((r) => {
    const c = concentrationByVendorId.get(r.vendor_id)
    return {
      ...r,
      pct_of_total_spend: c?.pct_of_total_spend ?? null,
      open_flag_count: c?.open_flag_count ?? 0,
      open_flag_amount_at_risk: c?.open_flag_amount_at_risk ?? null,
    }
  })

  const vendorBarItems: BarListItem[] = mergedVendorRows.slice(0, 12).map((r) => ({
    key: r.vendor_id,
    label: r.display_name,
    value: r.total_amount ?? 0,
    note: r.pct_of_total_spend != null ? `${r.pct_of_total_spend.toFixed(1)}%` : undefined,
  }))

  const zoneBarItems: BarListItem[] = data.zoneRows
    .filter((r) => (r.total_amount ?? 0) > 0)
    .map((r) => ({
      key: r.zone_id ?? 'unassigned',
      label: r.zone_name,
      value: r.total_amount ?? 0,
    }))

  const budgetColumns: DataTableColumn<BudgetVsActualRow>[] = [
    {
      key: 'head',
      header: 'Budget Head',
      render: (r) => (
        <Link
          href={`/entries?budget_head_id=${r.budget_head_id}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          {r.short_label ?? r.raw_label}
        </Link>
      ),
    },
    { key: 'department', header: 'Department', render: (r) => budgetDepartmentLabel(r.department_id) },
    { key: 'approved', header: 'Approved', align: 'right', render: (r) => formatINR(r.approved_amount) },
    { key: 'utilised', header: 'Utilised (source)', align: 'right', render: (r) => formatINR(r.utilised_amount) },
    { key: 'actual', header: 'Actual (sum of amounts)', align: 'right', render: (r) => formatINR(r.actual_amount) },
    { key: 'balance', header: 'Balance', align: 'right', render: (r) => formatINR(r.balance_amount) },
    {
      key: 'pct',
      header: '% of Approved',
      align: 'right',
      render: (r) =>
        r.budget_status_note ? (
          <span className="text-muted-foreground">{r.budget_status_note}</span>
        ) : (
          formatPercent(r.pct_of_approved)
        ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
  ]

  const deptBudgetColumns: DataTableColumn<DepartmentBudgetVsActualRow>[] = [
    {
      key: 'department',
      header: 'Department',
      render: (r) => (
        <Link
          href={`/entries?department_id=${r.department_id}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          {r.department_name}
        </Link>
      ),
    },
    { key: 'asOf', header: 'As of', render: (r) => formatDate(r.as_of) },
    { key: 'budget', header: 'Budget', align: 'right', render: (r) => formatINR(r.budget_amount) },
    { key: 'actual', header: 'Actual (sum of amounts)', align: 'right', render: (r) => formatINR(r.actual_amount) },
    {
      key: 'pct',
      header: '% of Budget',
      align: 'right',
      render: (r) =>
        r.budget_status_note ? (
          <span className="text-muted-foreground">{r.budget_status_note}</span>
        ) : (
          formatPercent(r.pct_of_budget)
        ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
  ]

  const vendorColumns: DataTableColumn<MergedVendorRow>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) => (
        <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.display_name}
        </Link>
      ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
    { key: 'total', header: 'Total Amount', align: 'right', render: (r) => formatINR(r.total_amount) },
    { key: 'first', header: 'First Entry', render: (r) => formatDate(r.first_entry_date) },
    { key: 'last', header: 'Last Entry', render: (r) => formatDate(r.last_entry_date) },
    { key: 'coverage', header: 'Doc Coverage', align: 'right', render: (r) => formatPercent(r.document_coverage_pct) },
    {
      key: 'pct',
      header: '% of Total Spend',
      align: 'right',
      render: (r) => (r.pct_of_total_spend != null ? `${r.pct_of_total_spend.toFixed(2)}%` : '—'),
    },
    {
      key: 'flags',
      header: 'Open Flags',
      align: 'right',
      render: (r) =>
        r.open_flag_count > 0 ? (
          <Link href={`/reports#compliance`} className="text-primary underline-offset-2 hover:underline">
            {formatNumber(r.open_flag_count)}
          </Link>
        ) : (
          formatNumber(r.open_flag_count)
        ),
    },
    { key: 'risk', header: '₹ at Risk', align: 'right', render: (r) => formatINR(r.open_flag_amount_at_risk) },
  ]

  const zoneColumns: DataTableColumn<ZoneSpendRow>[] = [
    {
      key: 'zone',
      header: 'Zone',
      render: (r) => (
        <Link
          href={r.zone_id ? `/entries?zone_id=${r.zone_id}` : '/entries?zone_id=none'}
          className="text-primary underline-offset-2 hover:underline"
        >
          {r.zone_name}
        </Link>
      ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
    { key: 'total', header: 'Total Amount', align: 'right', render: (r) => formatINR(r.total_amount) },
  ]

  const ageingColumns: DataTableColumn<HubAgeingRow>[] = [
    {
      key: 'ubbl',
      header: 'UBBL Number',
      render: (r) => (
        <Link href={`/entries/${r.entry_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.ubbl_number}
        </Link>
      ),
    },
    { key: 'status', header: 'Hub Status', render: (r) => r.hub_status_label },
    { key: 'days', header: 'Days in Status', align: 'right', render: (r) => formatNumber(r.days_in_status) },
    { key: 'bucket', header: 'Bucket', render: (r) => <AgeBucketBadge bucket={r.age_bucket} /> },
    { key: 'changed', header: 'Changed', render: (r) => formatDateTime(r.hub_status_changed_at) },
  ]

  const issueColumns: DataTableColumn<OpenIssueRow>[] = [
    { key: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} /> },
    { key: 'type', header: 'Type', render: (r) => humanizeCode(r.issue_type) },
    { key: 'source', header: 'Source', render: (r) => (r.source_table === 'flags' ? 'Flag' : 'Exception') },
    { key: 'amount', header: '₹ at risk', align: 'right', render: (r) => formatINR(r.amount_at_risk) },
    {
      key: 'entry',
      header: 'Entry',
      render: (r) =>
        r.entry_id ? (
          <Link href={`/entries/${r.entry_id}`} className="text-primary underline-offset-2 hover:underline">
            #{r.entry_id}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'description',
      header: 'Description',
      render: (r) => (
        <span className="block max-w-[24rem] truncate" title={r.description ?? undefined}>
          {r.description ?? '—'}
        </span>
      ),
    },
    { key: 'created', header: 'Raised', render: (r) => formatDate(r.created_at) },
  ]

  const complianceTotalAtRisk = analyticsData.complianceRows.reduce((sum, r) => sum + (r.amount_at_risk ?? 0), 0)
  const complianceByType = Object.entries(
    analyticsData.complianceRows.reduce<Record<string, number>>((acc, r) => {
      acc[r.flag_type] = (acc[r.flag_type] ?? 0) + 1
      return acc
    }, {})
  ).sort((a, b) => b[1] - a[1])

  const familyBarItems: BarListItem[] = analyticsData.familyRows
    .filter((r) => r.total_spend > 0)
    .slice(0, 12)
    .map((r) => ({ key: r.item_family_id, label: r.label, value: r.total_spend }))

  const complianceColumns: DataTableColumn<ComplianceRow>[] = [
    { key: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} /> },
    { key: 'type', header: 'Type', render: (r) => humanizeCode(r.flag_type) },
    { key: 'amount', header: '₹ at risk', align: 'right', render: (r) => formatINR(r.amount_at_risk) },
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) =>
        r.vendor_id ? (
          <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.vendor_display_name ?? `#${r.vendor_id}`}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'entry',
      header: 'Entry',
      render: (r) =>
        r.entry_id ? (
          <Link href={`/entries/${r.entry_id}`} className="text-primary underline-offset-2 hover:underline">
            #{r.entry_id}
          </Link>
        ) : r.related_entry_ids && r.related_entry_ids.length > 0 ? (
          <span className="text-muted-foreground">{r.related_entry_ids.length} entries</span>
        ) : (
          '—'
        ),
    },
    { key: 'department', header: 'Department', render: (r) => r.department_name ?? '—' },
    {
      key: 'description',
      header: 'Description',
      render: (r) => (
        <span className="block max-w-[24rem] truncate" title={r.description ?? undefined}>
          {r.description ?? '—'}
        </span>
      ),
    },
    { key: 'detected', header: 'Last Seen', render: (r) => formatDateTime(r.last_detected_at) },
  ]

  const familyColumns: DataTableColumn<SpendByFamilyRow>[] = [
    {
      key: 'family',
      header: 'Item Family',
      render: (r) => (
        <span className="flex items-center gap-1.5">
          {r.label}
          {!r.is_confirmed && (
            <span className="rounded border border-border px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              Proposed
            </span>
          )}
        </span>
      ),
    },
    { key: 'unit', header: 'Unit', render: (r) => r.default_unit ?? '—' },
    { key: 'spend', header: 'Total Spend', align: 'right', render: (r) => formatINR(r.total_spend) },
    { key: 'observations', header: 'Observations', align: 'right', render: (r) => formatNumber(r.observation_count) },
    { key: 'vendors', header: 'Vendors', align: 'right', render: (r) => formatNumber(r.vendor_count) },
  ]

  const benchmarkColumns: DataTableColumn<RateBenchmarkRow>[] = [
    { key: 'family', header: 'Item Family', render: (r) => r.family_label },
    { key: 'unit', header: 'Unit', render: (r) => r.unit_normalized ?? '—' },
    { key: 'median', header: 'Median Rate', align: 'right', render: (r) => formatINR(r.median_rate) },
    { key: 'min', header: 'Min', align: 'right', render: (r) => formatINR(r.min_rate) },
    { key: 'max', header: 'Max', align: 'right', render: (r) => formatINR(r.max_rate) },
    { key: 'observations', header: 'Observations', align: 'right', render: (r) => formatNumber(r.observation_count) },
    {
      key: 'vendors',
      header: 'Vendors',
      align: 'right',
      render: (r) => (
        <span
          className={
            r.vendor_count < RATE_BENCHMARK_MIN_VENDORS || r.observation_count < RATE_BENCHMARK_MIN_OBSERVATIONS
              ? 'text-muted-foreground'
              : undefined
          }
        >
          {formatNumber(r.vendor_count)}
        </span>
      ),
    },
  ]

  const benchmarkReliableRows = analyticsData.benchmarkRows.filter(
    (r) => r.vendor_count >= RATE_BENCHMARK_MIN_VENDORS && r.observation_count >= RATE_BENCHMARK_MIN_OBSERVATIONS
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
        {data.eventName && (
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {data.eventName}
          </span>
        )}
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        An overview of this event (spend pace, Hub status mix, document pipeline), then budget vs
        actual, vendor spend, zone spend, Hub-status ageing, open issues, compliance & leakage
        flags, item-family spend, and rate benchmarking (flags-run sweeps the corpus every 15
        minutes). CSV export on every section.
      </p>

      <nav className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border pb-3 text-xs">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="text-muted-foreground hover:text-foreground hover:underline">
            {s.label}
          </a>
        ))}
      </nav>

      <section id="overview" className="flex scroll-mt-20 flex-col gap-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">This event, so far</h2>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Total spend to date"
            value={formatINRCompact(hero.kpi.totalSpend)}
            delta={formatDeltaINR(spendDelta)}
            deltaTone="neutral"
            series={hero.kpi.weeklySpendSeries}
          />
          <KpiTile
            label="Entries this event"
            value={formatNumber(hero.kpi.totalEntries)}
            delta={formatDeltaCount(entryDelta, 'this week')}
            deltaTone="neutral"
            series={hero.kpi.weeklyEntrySeries}
          />
          <KpiTile
            label="Open ₹ at risk"
            value={formatINRCompact(hero.kpi.openAmountAtRisk)}
            delta={formatDeltaINR(riskDelta)}
            deltaTone={riskDelta == null ? 'neutral' : riskDelta > 0 ? 'bad' : 'good'}
            series={hero.kpi.weeklyAtRiskSeries}
          />
          <KpiTile
            label="Avg. days to review"
            value={hero.kpi.avgDaysToReview != null ? hero.kpi.avgDaysToReview.toFixed(1) : '—'}
            series={hero.kpi.weeklyAvgDaysSeries}
          />
        </div>
        {hero.errors.kpi && <p className="text-xs text-destructive">{hero.errors.kpi}</p>}

        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <ReportSection id="spend-pace" title="Spend pace" description="Cumulative spend for this event against an even-pace target line.">
            {hero.errors.spendTrend ? (
              <EmptyState title="Couldn't load spend pace" description={hero.errors.spendTrend} />
            ) : spendTrendPoints.length === 0 ? (
              <EmptyState title="Not enough data yet" description="Needs at least one entry, or an event with start/end dates set." />
            ) : (
              <TrendChart points={spendTrendPoints} valueFormatter={formatINRCompact} />
            )}
          </ReportSection>

          <div className="flex flex-col gap-4">
            <ReportSection id="hub-status-mix" title="Hub status mix" description="Where every entry sits in the review workflow right now.">
              {hero.errors.hubStatus ? (
                <EmptyState title="Couldn't load Hub status" description={hero.errors.hubStatus} />
              ) : hubStatusSegments.every((s) => s.value === 0) || hubStatusSegments.length === 0 ? (
                <EmptyState title="No entries yet" />
              ) : (
                <DonutChart segments={hubStatusSegments} centerLabel={`${formatNumber(hero.hubStatus.reduce((s, r) => s + r.value, 0))} entries`} />
              )}
            </ReportSection>

            <ReportSection id="document-pipeline" title="Document pipeline" description="Uploaded bills, and how many make it through each stage.">
              {hero.errors.pipeline ? (
                <EmptyState title="Couldn't load the pipeline" description={hero.errors.pipeline} />
              ) : hero.pipeline.every((p) => p.count === 0) ? (
                <EmptyState title="No documents uploaded yet" />
              ) : (
                <FunnelChart stages={hero.pipeline} />
              )}
            </ReportSection>
          </div>
        </div>
      </section>

      <ReportSection
        id="budget-vs-actual"
        title="Budget vs actual by head"
        description={
          data.budgetRows.some((r) => r.budget_status_note)
            ? 'Heads with no approved budget show "no approved budget" instead of a −100% figure (§3.5).'
            : 'Latest allocation snapshot against the sum of amounts per head.'
        }
        action={
          <ExportCsvButton
            filename="budget-vs-actual.csv"
            rowCount={data.budgetRows.length}
            csv={toCsv(budgetRowsGrouped, [
              { header: 'Budget Head', value: (r) => r.short_label ?? r.raw_label },
              { header: 'Department', value: (r) => budgetDepartmentLabel(r.department_id) },
              { header: 'Approved Amount', value: (r) => r.approved_amount },
              { header: 'Utilised Amount (source)', value: (r) => r.utilised_amount },
              { header: 'Actual (sum of amounts)', value: (r) => r.actual_amount },
              { header: 'Balance', value: (r) => r.balance_amount },
              { header: '% of Approved', value: (r) => r.pct_of_approved },
              { header: 'Note', value: (r) => r.budget_status_note },
              { header: 'Entries', value: (r) => r.entry_count },
            ])}
          />
        }
      >
        {data.errors.budget ? (
          <EmptyState title="Couldn't load budget data" description={data.errors.budget} />
        ) : data.budgetRows.length === 0 ? (
          <EmptyState title="No budget heads yet" description="Budget heads arrive via import." />
        ) : (
          <>
            <BarList items={budgetBarItems} valueFormatter={formatINRCompact} />
            <BudgetStatusLegend />
            <DataTable columns={budgetColumns} rows={budgetRowsGrouped} getRowKey={(r) => r.budget_head_id} />
          </>
        )}
      </ReportSection>

      <ReportSection
        id="department-budget-vs-actual"
        title="Department budget vs actual"
        description={
          data.deptBudgetRows.some((r) => r.budget_status_note)
            ? 'A separate, department-grained figure from Budget vs Actual above — imported directly per department, not rolled up from budget heads. Departments with no budget set show "no budget set" instead of a misleading −100% figure.'
            : 'A separate, department-grained figure from Budget vs Actual above — imported directly per department, not rolled up from budget heads.'
        }
        action={
          <ExportCsvButton
            filename="department-budget-vs-actual.csv"
            rowCount={data.deptBudgetRows.length}
            csv={toCsv(data.deptBudgetRows, [
              { header: 'Department', value: (r) => r.department_name },
              { header: 'As Of', value: (r) => r.as_of },
              { header: 'Budget Amount', value: (r) => r.budget_amount },
              { header: 'Actual (sum of amounts)', value: (r) => r.actual_amount },
              { header: '% of Budget', value: (r) => r.pct_of_budget },
              { header: 'Note', value: (r) => r.budget_status_note },
              { header: 'Entries', value: (r) => r.entry_count },
            ])}
          />
        }
      >
        {data.errors.deptBudget ? (
          <EmptyState title="Couldn't load department budget data" description={data.errors.deptBudget} />
        ) : data.deptBudgetRows.length === 0 ? (
          <EmptyState
            title="No department budgets yet"
            description="Department budgets arrive via the Department budget import on /import — no file has been provided yet."
          />
        ) : (
          <>
            <BarList items={deptBudgetBarItems} valueFormatter={formatINRCompact} />
            <BudgetStatusLegend />
            <DataTable columns={deptBudgetColumns} rows={data.deptBudgetRows} getRowKey={(r) => r.department_id} />
          </>
        )}
      </ReportSection>

      <div className="grid gap-4 md:grid-cols-2">
      <ReportSection
        id="vendor-spend"
        title="Vendor spend"
        description="Entry count, total spend, document coverage, share of total spend, and open-flag exposure per vendor. Merged from the former separate 'Vendor spend' and 'Vendor concentration' sections, which ranked the same vendors by the same spend (§5.2)."
        action={
          <ExportCsvButton
            filename="vendor-spend.csv"
            rowCount={mergedVendorRows.length}
            csv={toCsv(mergedVendorRows, [
              { header: 'Vendor', value: (r) => r.display_name },
              { header: 'Entries', value: (r) => r.entry_count },
              { header: 'Total Amount', value: (r) => r.total_amount },
              { header: 'First Entry Date', value: (r) => r.first_entry_date },
              { header: 'Last Entry Date', value: (r) => r.last_entry_date },
              { header: 'Document Coverage %', value: (r) => r.document_coverage_pct },
              { header: '% of Total Spend', value: (r) => r.pct_of_total_spend },
              { header: 'Open Flags', value: (r) => r.open_flag_count },
              { header: '₹ at Risk', value: (r) => r.open_flag_amount_at_risk },
            ])}
          />
        }
      >
        {data.errors.vendor ? (
          <EmptyState title="Couldn't load vendor spend" description={data.errors.vendor} />
        ) : mergedVendorRows.length === 0 ? (
          <EmptyState title="No vendor spend yet" description="Vendors are created automatically as entries import." />
        ) : (
          <>
            {analyticsData.errors.concentration && (
              <p className="text-xs text-destructive">
                {analyticsData.errors.concentration} — % of total spend, open flags, and ₹ at risk below may be
                incomplete.
              </p>
            )}
            <BarList items={vendorBarItems} valueFormatter={formatINRCompact} />
            <DataTable columns={vendorColumns} rows={mergedVendorRows} getRowKey={(r) => r.vendor_id} />
          </>
        )}
      </ReportSection>

      <ReportSection
        id="zone-spend"
        title="Spend by zone"
        description="Null zone is reported as 'unassigned' so gaps in enrichment stay visible."
        action={
          <ExportCsvButton
            filename="zone-spend.csv"
            rowCount={data.zoneRows.length}
            csv={toCsv(data.zoneRows, [
              { header: 'Zone', value: (r) => r.zone_name },
              { header: 'Entries', value: (r) => r.entry_count },
              { header: 'Total Amount', value: (r) => r.total_amount },
            ])}
          />
        }
      >
        {data.errors.zone ? (
          <EmptyState title="Couldn't load zone spend" description={data.errors.zone} />
        ) : data.zoneRows.length === 0 ? (
          <EmptyState title="No zone spend yet" />
        ) : (
          <>
            <BarList items={zoneBarItems} valueFormatter={formatINRCompact} />
            <DataTable columns={zoneColumns} rows={data.zoneRows} getRowKey={(r) => r.zone_id ?? 'unassigned'} />
          </>
        )}
      </ReportSection>

      <ReportSection
        id="hub-status-ageing"
        title="Hub-status ageing"
        description="Days each entry has sat in Awaiting Verification / Awaiting Validation — what the modules are waiting on."
        action={
          <ExportCsvButton
            filename="hub-status-ageing.csv"
            rowCount={data.ageingRows.length}
            csv={toCsv(data.ageingRows, [
              { header: 'UBBL Number', value: (r) => r.ubbl_number },
              { header: 'Hub Status', value: (r) => r.hub_status_label },
              { header: 'Days in Status', value: (r) => r.days_in_status },
              { header: 'Age Bucket', value: (r) => r.age_bucket },
              { header: 'Changed At', value: (r) => r.hub_status_changed_at },
            ])}
          />
        }
      >
        {data.errors.ageing ? (
          <EmptyState title="Couldn't load Hub-status ageing" description={data.errors.ageing} />
        ) : data.ageingRows.length === 0 ? (
          <EmptyState
            title="Nothing awaiting verification or validation"
            description="Entries appear here once a Hub status is set from the review queue or entry detail screen."
          />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              {(['0-2', '3-7', '8+'] as const).map((bucket) => (
                <div key={bucket} className="rounded-md border border-border p-3">
                  <p className="text-2xl font-mono font-semibold tracking-tight">
                    {formatNumber(data.ageingBuckets[bucket])}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{bucket} days</p>
                </div>
              ))}
            </div>
            <DataTable columns={ageingColumns} rows={data.ageingRows} getRowKey={(r) => r.entry_id} />
          </>
        )}
      </ReportSection>

      <ReportSection
        id="open-issues"
        title="Open issues digest"
        description="Reconciliation exceptions and flags, sorted by severity then ₹ at risk."
        action={
          <ExportCsvButton
            filename="open-issues.csv"
            rowCount={data.issueRows.length}
            csv={toCsv(data.issueRows, [
              { header: 'Source', value: (r) => (r.source_table === 'flags' ? 'Flag' : 'Exception') },
              { header: 'Type', value: (r) => r.issue_type },
              { header: 'Severity', value: (r) => r.severity },
              { header: '₹ at risk', value: (r) => r.amount_at_risk },
              { header: 'Entry', value: (r) => r.entry_id },
              { header: 'Description', value: (r) => r.description },
              { header: 'Raised', value: (r) => r.created_at },
            ])}
          />
        }
      >
        {data.errors.issues ? (
          <EmptyState title="Couldn't load open issues" description={data.errors.issues} />
        ) : (
          <>
            {issueSeveritySegments.length > 0 && <DonutChart segments={issueSeveritySegments} centerLabel={`${data.issueRows.length} issues`} />}
            <DataTable
            columns={issueColumns}
            rows={data.issueRows}
            getRowKey={(r) => `${r.source_table}-${r.id}`}
            emptyTitle="No open issues"
            emptyDescription="Nothing in reconciliation_exception or flags is currently open."
            />
          </>
        )}
      </ReportSection>

      <ReportSection
        id="compliance"
        title="Compliance & leakage"
        description="Open flags sorted by severity then ₹ at risk — tax, GSTIN, and statutory findings alongside vendor-pattern findings (splitting, duplicate payment, TDS threshold)."
        action={
          <ExportCsvButton
            filename="compliance-flags.csv"
            rowCount={analyticsData.complianceRows.length}
            csv={toCsv(analyticsData.complianceRows, [
              { header: 'Type', value: (r) => r.flag_type },
              { header: 'Severity', value: (r) => r.severity },
              { header: '₹ at risk', value: (r) => r.amount_at_risk },
              { header: 'Vendor', value: (r) => r.vendor_display_name },
              { header: 'Entry', value: (r) => r.entry_id },
              { header: 'Department', value: (r) => r.department_name },
              { header: 'Description', value: (r) => r.description },
              { header: 'First Detected', value: (r) => r.created_at },
              { header: 'Last Seen', value: (r) => r.last_detected_at },
            ])}
          />
        }
      >
        {analyticsData.errors.compliance ? (
          <EmptyState title="Couldn't load compliance flags" description={analyticsData.errors.compliance} />
        ) : analyticsData.complianceRows.length === 0 ? (
          <EmptyState
            title="No open compliance flags"
            description="flags-run scans every verified document and vendor payment history every 15 minutes. This is expected to be empty until documents have been reviewed (Day 4 verify) and at least one sweep has run."
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-md border border-border p-3">
                <p className="text-2xl font-mono font-semibold tracking-tight">{formatNumber(analyticsData.complianceRows.length)}</p>
                <p className="mt-1 text-xs text-muted-foreground">open flags</p>
              </div>
              <div className="rounded-md border border-border p-3">
                <p className="text-2xl font-mono font-semibold tracking-tight">{formatINRCompact(complianceTotalAtRisk)}</p>
                <p className="mt-1 text-xs text-muted-foreground">total ₹ at risk</p>
              </div>
              {complianceByType.slice(0, 2).map(([type, count]) => (
                <div key={type} className="rounded-md border border-border p-3">
                  <p className="text-2xl font-mono font-semibold tracking-tight">{formatNumber(count)}</p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{humanizeCode(type)}</p>
                </div>
              ))}
            </div>
            {complianceSeveritySegments.length > 0 && <DonutChart segments={complianceSeveritySegments} centerLabel={`${analyticsData.complianceRows.length} flags`} />}
            <DataTable columns={complianceColumns} rows={analyticsData.complianceRows} getRowKey={(r) => r.id} />
          </>
        )}
      </ReportSection>

      <ReportSection
        id="spend-by-family"
        title="Spend by item family"
        description="Cross-vendor comparable item groupings (e.g. 'gypsum ceiling', 'pvc boring pipe') — the level rates are actually comparable at, per the two-level item catalog (family → exact spec)."
        action={
          <ExportCsvButton
            filename="spend-by-family.csv"
            rowCount={analyticsData.familyRows.length}
            csv={toCsv(analyticsData.familyRows, [
              { header: 'Item Family', value: (r) => r.label },
              { header: 'Unit', value: (r) => r.default_unit },
              { header: 'Total Spend', value: (r) => r.total_spend },
              { header: 'Observations', value: (r) => r.observation_count },
              { header: 'Vendors', value: (r) => r.vendor_count },
              { header: 'Confirmed', value: (r) => (r.is_confirmed ? 'yes' : 'no') },
            ])}
          />
        }
      >
        {analyticsData.errors.family ? (
          <EmptyState title="Couldn't load spend by family" description={analyticsData.errors.family} />
        ) : analyticsData.familyRows.length === 0 ? (
          <EmptyState
            title="No item families yet"
            description="The catalog is back-filled from verified line items as documents are reviewed — see /catalog to confirm proposed families."
          />
        ) : (
          <>
            <BarList items={familyBarItems} valueFormatter={formatINRCompact} />
            <DataTable columns={familyColumns} rows={analyticsData.familyRows} getRowKey={(r) => r.item_family_id} />
          </>
        )}
      </ReportSection>

      <ReportSection
        id="rate-benchmark"
        title="Rate benchmark"
        description={`Median rate per item family + unit, across vendors. Greyed vendor counts have fewer than ${RATE_BENCHMARK_MIN_VENDORS} vendors or ${RATE_BENCHMARK_MIN_OBSERVATIONS} observations — not yet a reliable benchmark, shown for visibility only.`}
        action={
          <ExportCsvButton
            filename="rate-benchmark.csv"
            rowCount={analyticsData.benchmarkRows.length}
            csv={toCsv(analyticsData.benchmarkRows, [
              { header: 'Item Family', value: (r) => r.family_label },
              { header: 'Unit', value: (r) => r.unit_normalized },
              { header: 'Median Rate', value: (r) => r.median_rate },
              { header: 'Min Rate', value: (r) => r.min_rate },
              { header: 'Max Rate', value: (r) => r.max_rate },
              { header: 'Observations', value: (r) => r.observation_count },
              { header: 'Vendors', value: (r) => r.vendor_count },
            ])}
          />
        }
      >
        {analyticsData.errors.benchmark ? (
          <EmptyState title="Couldn't load rate benchmark" description={analyticsData.errors.benchmark} />
        ) : analyticsData.benchmarkRows.length === 0 ? (
          <EmptyState
            title="Not enough data yet"
            description="Rate comparison needs multiple vendors billing the same item family. The pilot corpus has almost no cross-vendor overlap — this fills in as more documents are verified across more vendors."
          />
        ) : (
          <>
            {benchmarkReliableRows.length === 0 && (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                No family/unit pair yet has {RATE_BENCHMARK_MIN_VENDORS}+ vendors and {RATE_BENCHMARK_MIN_OBSERVATIONS}+
                observations — every row below is directional only.
              </p>
            )}
            <DataTable
              columns={benchmarkColumns}
              rows={analyticsData.benchmarkRows}
              getRowKey={(r) => `${r.item_family_id}-${r.unit_normalized ?? 'none'}`}
            />
          </>
        )}
      </ReportSection>
      </div>
    </div>
  )
}

function BudgetStatusLegend() {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-emerald-600 dark:bg-emerald-500" />
        Within budget
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-amber-500 dark:bg-amber-400" />
        Near limit
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-red-600 dark:bg-red-500" />
        Over budget
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-0.5 w-3 bg-foreground/70" />
        Approved amount
      </span>
    </div>
  )
}
