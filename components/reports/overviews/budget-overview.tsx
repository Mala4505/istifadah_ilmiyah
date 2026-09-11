import { Suspense, cache } from 'react'
import type { Event } from '@/lib/events/types'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { loadBudgetSurface } from '@/lib/reports/surfaces/budget'
import { loadSpendCurveOpenAgeing } from '@/lib/reports/surfaces/spend-curve-open-ageing'
import { DepartmentBudgetSection } from '@/components/reports/sections/department-budget'
import { SpendCurveSection } from '@/components/reports/sections/spend-curve'
import { SectionSkeleton } from '@/components/reports/sections/surface-loading'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { EmptyState } from '@/components/reports/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDeltaVs } from '@/lib/reports/sections/shared'
import { formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import { SURFACE_SECTIONS, sectionHref } from '@/lib/reports/surface-sections'

/**
 * Budget & Spend surface — Overview (redesign plan Phase 3.2, Agent A). The
 * "rest state" of the Budget pane: what renders when `?report=` is unset
 * (Phase 3.3 wires it in). A condensed front for app/(app)/reports/budget/
 * page.tsx — the two flagship sections here are the exact `*Section`
 * components that page renders, fed by the exact same `cache()`d loaders and
 * prop wiring, so the overview and the full surface never drift.
 *
 * Top to bottom (plan 3.2): a 4-tile hero row from `loadBudgetSurface` →
 * the two flagship sections (department budget-vs-actual · spend pace),
 * each with its own insight sentence already → a `<details>` disclosure
 * that links out to the remaining Budget breakdowns. It does NOT re-render
 * every section's chart — the disclosure is a discovery aid, and the
 * single-section full-fidelity view is one click away.
 *
 * The plan's 3.2 sketch put the two flagships in a `lg:grid-cols-2` row.
 * They're overridden to a full-width stack here: both are composite section
 * presenters (card + KPI tile + insight + chart + a wide DataTable), not
 * bare chart marks, and at half the pane width — already narrowed by the
 * persistent left index rail — the embedded tables collapse to
 * horizontal-scroll strips. This matches the call the sibling Vendors /
 * Integrity overviews made (skill-observations log #84) and the `dataviz`
 * skill's "a chart that reads badly at half width may span full width".
 */

const getBudgetSurface = cache(loadBudgetSurface)
const getSpendCurveOpenAgeing = cache(loadSpendCurveOpenAgeing)

/**
 * The two Budget sections rendered in full above the disclosure. Kept as a
 * set so the disclosure's "N breakdowns" count is derived from
 * `SURFACE_SECTIONS.budget` (never hardcoded) — add/remove a flagship here
 * and N follows.
 */
const FLAGSHIP_SECTION_IDS: ReadonlySet<string> = new Set([
  'department-budget-vs-actual', // <DepartmentBudgetSection>
  'spend-curve', // <SpendCurveSection>
])

/** Every Budget section that isn't rendered in full above — the disclosure list. */
const BREAKDOWN_SECTIONS = SURFACE_SECTIONS.budget.filter((s) => !FLAGSHIP_SECTION_IDS.has(s.id))

export async function BudgetOverview({
  compareBasis,
  selectedEvent,
}: {
  compareBasis: CompareBasis
  selectedEvent: Event | null
}) {
  return (
    <div className="flex flex-col gap-4">
      <Suspense fallback={<HeroRowFallback />}>
        <BudgetHeroRow compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>

      <Suspense fallback={<SectionSkeleton />}>
        <DepartmentFlagship compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <SpendPaceFlagship compareBasis={compareBasis} />
      </Suspense>

      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm text-muted-foreground marker:text-muted-foreground hover:text-foreground">
          Show all {BREAKDOWN_SECTIONS.length} breakdowns
        </summary>
        <ul className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {BREAKDOWN_SECTIONS.map((s) => (
            <li key={s.id}>
              <a
                href={sectionHref('budget', s.id)}
                className="text-sm text-primary underline-offset-2 hover:underline"
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}

async function BudgetHeroRow({
  compareBasis,
  selectedEvent,
}: {
  compareBasis: CompareBasis
  selectedEvent: Event | null
}) {
  const data = await getBudgetSurface(compareBasis, selectedEvent)

  if (data.byHead.error) {
    return <EmptyState title="Couldn't load the budget figures" description={data.byHead.error} />
  }

  const heads = data.byHead.rows
  const deptError = data.byDepartment.error
  const deptsWithBudget = data.byDepartment.rows.filter((r) => r.budget_amount != null && r.budget_amount > 0)
  const overBudgetCount = deptsWithBudget.filter((r) => (r.pct_of_budget ?? 0) > 100).length

  const approvedTotal = heads.reduce((s, r) => s + (r.approved_amount ?? 0), 0)
  const actualTotal = heads.reduce((s, r) => s + (r.actual_amount ?? 0), 0)
  const overallPct = approvedTotal > 0 ? (actualTotal / approvedTotal) * 100 : null
  const previousActual = compareBasis === 'prior_event' ? data.byHead.previousActualTotal : null

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <KpiTile label="Approved budget" value={formatINRCompact(approvedTotal)} />
      <KpiTile
        label="Actual spend"
        value={formatINRCompact(actualTotal)}
        delta={formatDeltaVs(compareBasis, actualTotal, previousActual, 'inr')}
        deltaTone="neutral"
      />
      <KpiTile
        label="% of approved budget"
        value={overallPct != null ? formatPercent(overallPct) : '—'}
        delta={overallPct != null ? 'actual against approved, all heads' : 'no approved budget on record'}
        deltaTone={overallPct != null && overallPct > 100 ? 'bad' : 'neutral'}
      />
      <KpiTile
        label="Departments over budget"
        value={deptError ? '—' : formatNumber(overBudgetCount)}
        delta={
          deptError
            ? 'department figures unavailable'
            : deptsWithBudget.length > 0
              ? `of ${deptsWithBudget.length} with a budget set`
              : 'no department budgets set'
        }
        deltaTone={!deptError && overBudgetCount > 0 ? 'bad' : 'neutral'}
      />
    </div>
  )
}

async function DepartmentFlagship({
  compareBasis,
  selectedEvent,
}: {
  compareBasis: CompareBasis
  selectedEvent: Event | null
}) {
  const data = await getBudgetSurface(compareBasis, selectedEvent)
  return (
    <DepartmentBudgetSection
      rows={data.byDepartment.rows}
      error={data.byDepartment.error}
      compareBasis={compareBasis}
      previousActualTotal={data.byDepartment.previousActualTotal}
      eventName={selectedEvent?.name ?? null}
    />
  )
}

async function SpendPaceFlagship({ compareBasis }: { compareBasis: CompareBasis }) {
  const spendCurve = await getSpendCurveOpenAgeing(compareBasis)
  return (
    <SpendCurveSection
      rows={spendCurve.spendCurve.rows}
      error={spendCurve.spendCurve.error}
      compareBasis={compareBasis}
      totalSpend={spendCurve.spendCurve.totalSpend}
      eventWeekCount={spendCurve.spendCurve.eventWeekCount}
      peakWeekStart={spendCurve.spendCurve.peakWeekStart}
      peakWeekAmount={spendCurve.spendCurve.peakWeekAmount}
      meanWeeklyAmount={spendCurve.spendCurve.meanWeeklyAmount}
      peakMultipleOfMean={spendCurve.spendCurve.peakMultipleOfMean}
      previousPeakWeekAmount={spendCurve.spendCurve.previousPeakWeekAmount}
    />
  )
}

function HeroRowFallback() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-[88px] rounded-md" />
      ))}
    </div>
  )
}
