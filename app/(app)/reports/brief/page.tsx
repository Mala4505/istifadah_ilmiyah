import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { getCompareBasis } from '@/lib/reports/compare-basis'
import { loadHeroMetrics } from '@/lib/reports/hero-metrics'
import { loadExecutiveBrief, type DepartmentLeagueRow, type NeedsDecisionRow } from '@/lib/reports/executive-brief'
import { loadWeeklyDigest } from '@/lib/reports/weekly-digest'
import { loadRupeeProvenance } from '@/lib/reports/surfaces/rupee-provenance'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { TrendChart } from '@/components/reports/charts/trend-chart'
import { AttentionMapChart, type AttentionMapPoint } from '@/components/reports/charts/attention-map-chart'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { SeverityBadge } from '@/components/reports/severity-badge'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { PresentModeToggle } from '@/components/reports/present-mode-toggle'
import { WeeklyDigestSection } from '@/components/reports/sections/weekly-digest'
import { RupeeProvenanceSection } from '@/components/reports/sections/rupee-provenance'
import { BoardPackList } from '@/components/reports/sections/board-pack-list'
import { toCsv, type CsvColumn } from '@/lib/reports/csv'
import { parsePositiveIntParam } from '@/lib/reports/search-params'
import { formatINRCompact, formatPercent, humanizeCode } from '@/lib/reports/format'

// Executive Brief -- reporting-blueprint.md §5 (Screen architecture) and §8
// Phase Two ("Build the Executive Brief on top of [E-01/E-02/A-03/A-04's
// views]. Add Present mode."). A new, self-contained route under the existing
// Reports shell (app/(app)/reports/layout.tsx already supplies the sticky
// event/compare-basis bar) rather than a 12th section bolted onto the
// 1937-line app/(app)/reports/page.tsx -- that file's own header notes it's
// owned by a concurrent stream this phase, and splitting Reports into
// per-section surfaces is explicitly Phase Three's job (§8), not this one's.
//
// Composed as the doc's §5 layout describes, top to bottom as an argument:
//   1. KPI row (5 tiles, lib/reports/executive-brief.ts's `kpi`)
//   2. "What changed this week" -- plain sentences, not a chart (`sentences`)
//   3. Two charts -- E-02 attention map + A-03 spend pace w/ a landing note
//   4. Two panels -- E-01 department league table + E-04 "needs your decision"
//   5. Footer -- CSV export (the event/compare-basis controls already live in
//      the shell above; Present mode's toggle sits in the header instead so
//      it stays reachable at every scroll position, including once band 5 is
//      off-screen).
export const dynamic = 'force-dynamic'

export default async function ExecutiveBriefPage({
  searchParams,
}: {
  searchParams: Promise<{ trace_entry_id?: string }>
}) {
  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent(supabase)
  const eventId = selectedEvent?.id ?? null
  const compareBasis = await getCompareBasis()
  const sp = await searchParams
  const traceEntryId = parsePositiveIntParam(sp.trace_entry_id)

  // Sequential, not Promise.all: loadExecutiveBrief reuses loadHeroMetrics's
  // already-computed totalSpend/openAmountAtRisk (both loaders' own internal
  // queries stay fully parallel via their own Promise.all) rather than
  // re-querying `entries`/`v_open_issues` a second time for the same figures.
  const hero = await loadHeroMetrics(eventId)
  const [brief, weeklyDigest, provenance] = await Promise.all([
    loadExecutiveBrief(eventId, hero.kpi.totalSpend, hero.kpi.openAmountAtRisk),
    loadWeeklyDigest(eventId),
    loadRupeeProvenance(compareBasis, traceEntryId),
  ])

  const digestErrorText = Object.values(weeklyDigest.errors).find((e): e is string => e != null) ?? null

  const spendTrendPoints = hero.spendTrend.map((p) => ({ label: p.weekLabel, actual: p.actual, target: p.target }))

  const attentionPoints: AttentionMapPoint[] = brief.attentionPoints.map((p) => ({ key: p.key, label: p.label, x: p.x, y: p.y }))

  const leagueColumns: DataTableColumn<DepartmentLeagueRow>[] = [
    { key: 'department', header: 'Department', render: (r) => r.departmentName },
    { key: 'spend', header: 'Spend', align: 'right', render: (r) => formatINRCompact(r.spend) },
    { key: 'share', header: 'Share', align: 'right', render: (r) => (r.spendSharePct != null ? formatPercent(r.spendSharePct) : '—') },
    {
      key: 'budget',
      header: 'Budget adherence',
      align: 'right',
      render: (r) => r.budgetStatusNote ?? (r.pctOfBudget != null ? formatPercent(r.pctOfBudget) : '—'),
    },
    {
      key: 'landing',
      header: 'Projected landing',
      align: 'right',
      render: (r) => (r.projectedLandingPct != null ? formatPercent(r.projectedLandingPct) : '—'),
    },
    {
      key: 'doc',
      header: 'Documentation',
      align: 'right',
      render: (r) => (r.documentCoveragePct != null ? formatPercent(r.documentCoveragePct) : '—'),
    },
    { key: 'risk', header: '₹ at risk', align: 'right', render: (r) => (r.amountAtRisk > 0 ? formatINRCompact(r.amountAtRisk) : '—') },
  ]

  const needsDecisionColumns: DataTableColumn<NeedsDecisionRow>[] = [
    { key: 'issue', header: 'Issue', render: (r) => humanizeCode(r.issueType) },
    { key: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} /> },
    { key: 'amount', header: '₹ at risk', align: 'right', render: (r) => (r.amountAtRisk != null ? formatINRCompact(r.amountAtRisk) : '—') },
    { key: 'owner', header: 'Owner', render: (r) => r.owner },
    { key: 'age', header: 'Age', align: 'right', render: (r) => `${r.ageDays}d` },
  ]

  const leagueCsvColumns: CsvColumn<DepartmentLeagueRow>[] = [
    { header: 'Department', value: (r) => r.departmentName },
    { header: 'Spend', value: (r) => r.spend },
    { header: 'Share %', value: (r) => r.spendSharePct },
    { header: '% of budget', value: (r) => r.pctOfBudget },
    { header: 'Budget status', value: (r) => r.budgetStatusNote },
    { header: 'Projected landing %', value: (r) => r.projectedLandingPct },
    { header: 'Documentation %', value: (r) => r.documentCoveragePct },
    { header: '₹ at risk', value: (r) => r.amountAtRisk },
    { header: 'Open issues', value: (r) => r.openIssueCount },
  ]

  const needsDecisionCsvColumns: CsvColumn<NeedsDecisionRow>[] = [
    { header: 'Issue type', value: (r) => humanizeCode(r.issueType) },
    { header: 'Severity', value: (r) => r.severity },
    { header: '₹ at risk', value: (r) => r.amountAtRisk },
    { header: 'Owner', value: (r) => r.owner },
    { header: 'Age (days)', value: (r) => r.ageDays },
    { header: 'Description', value: (r) => r.description },
  ]

  const eventLabel = brief.eventName ?? 'This event'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Executive Brief</h1>
          {eventLabel && (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{eventLabel}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link href="/reports" className="text-xs text-muted-foreground hover:text-foreground hover:underline" data-hide-in-present>
            Full report & drill workspace →
          </Link>
          <PresentModeToggle />
        </div>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground" data-hide-in-present>
        The trustee-facing view: is this event under control, in one screen. Present mode strips the chrome for a projector — the same
        control top-right, or Esc to exit.
      </p>

      {/* Band 1 -- KPI row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <KpiTile label="Spend vs budget" value={brief.kpi.spendVsBudgetValue} delta={brief.kpi.spendVsBudgetDelta} deltaTone={brief.kpi.spendVsBudgetTone} />
        <KpiTile
          label="Projected landing"
          value={brief.kpi.projectedLandingValue}
          delta={brief.kpi.projectedLandingValue !== '—' ? 'of budget, at current pace' : undefined}
          deltaTone={brief.kpi.projectedLandingTone}
        />
        <KpiTile label={brief.kpi.vendorConcentrationLabel} value={brief.kpi.vendorConcentrationValue} />
        <KpiTile label="Above-median spend" value={brief.kpi.aboveMedianSpendValue} delta="above our own median rate" deltaTone="neutral" />
        <KpiTile label="Open ₹ at risk" value={brief.kpi.openAmountAtRiskValue} />
      </div>
      {(hero.errors.kpi || brief.errors.league) && (
        <p className="text-xs text-destructive">{hero.errors.kpi ?? brief.errors.league}</p>
      )}

      {/* Band 2 -- what changed this week */}
      {brief.sentences.length > 0 && (
        <ReportSection title="What changed this week" description="Computed from the same figures as the tiles and charts below.">
          <ul className="flex flex-col gap-1.5 text-sm text-foreground">
            {brief.sentences.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-muted-foreground">—</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </ReportSection>
      )}

      {/* Band 2b -- E-04 weekly digest: the ten things most worth attention
          this week, ranked by rupees, each a plain sentence with an owner. */}
      <WeeklyDigestSection
        items={weeklyDigest.items}
        hasError={digestErrorText != null}
        errorText={digestErrorText}
      />

      {/* Band 3 -- two charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ReportSection
          title="Attention map"
          description="Departments by spend and documentation strength — the shaded corner is high spend, weak documentation."
        >
          {brief.errors.league ? (
            <EmptyState title="Couldn't load the attention map" description={brief.errors.league} />
          ) : attentionPoints.length === 0 ? (
            <EmptyState title="No spend yet this event" />
          ) : (
            <AttentionMapChart points={attentionPoints} />
          )}
        </ReportSection>

        <ReportSection title="Spend pace" description="Cumulative spend against an even-pace target line, this event.">
          {hero.errors.spendTrend ? (
            <EmptyState title="Couldn't load spend pace" description={hero.errors.spendTrend} />
          ) : spendTrendPoints.length === 0 ? (
            <EmptyState title="Not enough data yet" description="Needs at least one entry, or an event with start/end dates set." />
          ) : (
            <div className="flex flex-col gap-2">
              <TrendChart points={spendTrendPoints} valueFormat="inr-compact" />
              {brief.kpi.projectedLandingValue !== '—' && (
                <p className="text-xs text-muted-foreground">
                  At the current pace, this event projects to land at {brief.kpi.projectedLandingValue} of budget.
                </p>
              )}
            </div>
          )}
        </ReportSection>
      </div>

      {/* Band 4 -- two panels */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ReportSection
          title="Department league table"
          description="Ranked by spend. Every column carries a real figure — no budget set shows as a status note, not a misleading −100%."
          action={
            <ExportCsvButton csv={toCsv(brief.leagueTable, leagueCsvColumns)} rowCount={brief.leagueTable.length} filename="executive-brief-department-league.csv" />
          }
        >
          {brief.errors.league ? (
            <EmptyState title="Couldn't load the league table" description={brief.errors.league} />
          ) : (
            <DataTable columns={leagueColumns} rows={brief.leagueTable} getRowKey={(r) => r.departmentId} emptyTitle="No departments with spend yet" />
          )}
        </ReportSection>

        <ReportSection
          title="Needs your decision"
          description="The ten open issues carrying the most ₹ at risk, ranked."
          action={
            <ExportCsvButton
              csv={toCsv(brief.needsDecision, needsDecisionCsvColumns)}
              rowCount={brief.needsDecision.length}
              filename="executive-brief-needs-decision.csv"
            />
          }
        >
          {brief.errors.needsDecision ? (
            <EmptyState title="Couldn't load open issues" description={brief.errors.needsDecision} />
          ) : (
            <DataTable columns={needsDecisionColumns} rows={brief.needsDecision} getRowKey={(r) => r.key} emptyTitle="No open issues" />
          )}
        </ReportSection>
      </div>

      {/* Band 4b -- E-05 rupee provenance trace: pick any rupee and follow it
          budget head -> allocation -> entry -> bill -> line item -> family ->
          benchmark. Keyed on ?trace_entry_id= in the URL. */}
      <RupeeProvenanceSection
        candidates={provenance.candidates}
        candidatesError={provenance.candidatesError}
        chain={provenance.chain}
        traceEntryId={provenance.traceEntryId}
      />

      {/* Band 4c -- the board pack: this Brief frozen to a workbook + PDF on a
          weekly schedule (blueprint §5). */}
      <BoardPackList />

      {/* Band 5 -- footer */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground" data-hide-in-present>
        <p>Event and comparison-period controls are in the bar above. Present mode strips this footer and the nav for a projector.</p>
        <Link href="/reports" className="hover:text-foreground hover:underline">
          Open the full report →
        </Link>
      </div>
    </div>
  )
}
