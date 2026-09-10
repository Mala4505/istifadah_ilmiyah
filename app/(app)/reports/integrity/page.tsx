import { Suspense, cache } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import type { Event } from '@/lib/events/types'
import { getCompareBasis, type CompareBasis } from '@/lib/reports/compare-basis'
import { round2Local } from '@/lib/reports/sections/shared'
import { loadIntegritySurface } from '@/lib/reports/surfaces/integrity'
import { loadReconciliationGap } from '@/lib/reports/surfaces/reconciliation-gap'
import { loadAmountForensics } from '@/lib/reports/surfaces/amount-forensics'
import { loadSpendCurveOpenAgeing } from '@/lib/reports/surfaces/spend-curve-open-ageing'
import { loadDuplicateVendorRisk } from '@/lib/reports/surfaces/duplicate-vendor-risk'
import { loadThresholdSplitting } from '@/lib/reports/surfaces/threshold-splitting'
import { HubStatusAgeingSection } from '@/components/reports/sections/hub-status-ageing'
import { OpenIssuesSection } from '@/components/reports/sections/open-issues'
import { ComplianceSection } from '@/components/reports/sections/compliance'
import { ExceptionHeatmapSection } from '@/components/reports/sections/exception-heatmap'
import { AmountAtRiskWaterfallSection } from '@/components/reports/sections/amount-at-risk-waterfall'
import { OpenItemAgeingSection } from '@/components/reports/sections/open-item-ageing'
import { DuplicatePaymentRegisterSection } from '@/components/reports/sections/duplicate-payment-register'
import { LedgerBillReconciliationSection } from '@/components/reports/sections/ledger-bill-reconciliation'
import { EntriesWithoutBillSection } from '@/components/reports/sections/entries-without-bill'
import { BenfordDigitTestSection } from '@/components/reports/sections/benford-digit-test'
import { RoundNumberBiasSection } from '@/components/reports/sections/round-number-bias'
import { ThresholdSplittingSection } from '@/components/reports/sections/threshold-splitting'
import { SectionSkeleton } from '@/components/reports/sections/surface-loading'
import { IntegrityOverview } from '@/components/reports/overviews/integrity-overview'
import {
  OVERVIEW_SECTION,
  resolveSection,
  isSectionInPane,
  groupHiddenInPane,
} from '@/lib/reports/surface-sections'

/**
 * Integrity surface (reporting-blueprint.md §5 / §8 Phase Three / Phase Six).
 * One of the five Reports front doors -- the review function's view of what
 * does not add up. The sticky event/compare-basis bar and the surface nav
 * both live in app/(app)/reports/layout.tsx.
 *
 * A thin route over per-section presenters (§6 fix #10): the same components
 * render on /reports (Explore), so the two surfaces stay identical by
 * construction.
 *
 * Carries the full Family D catalogue: D-01 (exception heat map), D-02
 * (amount-at-risk waterfall), D-03 (open-item ageing), D-04 (duplicate
 * payment register), D-05 (ledger vs bill reconciliation), D-06 (entries
 * with no supporting bill), D-07 (Benford digit test), D-08 (round-number
 * bias), D-09 (threshold splitting).
 *
 * Perf remediation Phase 6.1 (docs/performance-remediation-plan.md): each
 * loader below used to be one member of a single page-wide `Promise.all`,
 * so the slowest of the six gated every section, including ones that
 * resolved instantly. Each is now awaited inside its own async Server
 * Component behind its own `<Suspense>`, so a section streams in as soon as
 * its own query settles instead of waiting on the others. `loadIntegritySurface`
 * feeds two non-adjacent groups of sections (Hub/Open-issues, then
 * Compliance/Heatmap/Waterfall) -- wrapped in `cache()` so both groups share
 * one query instead of running it twice.
 */
export const dynamic = 'force-dynamic'

const getIntegritySurface = cache(loadIntegritySurface)

export default async function IntegritySurfacePage({
  searchParams,
}: {
  searchParams: Promise<{ report?: string }>
}) {
  const { report } = await searchParams
  const active = resolveSection('integrity', report)
  const isOverview = active.id === OVERVIEW_SECTION.id
  const only = isOverview ? null : active.id

  const compareBasis = await getCompareBasis()
  const selectedEvent = await getSelectedEvent()
  const eventName = selectedEvent?.name ?? null

  // Perf remediation Phase 2.4 (docs/performance-remediation-plan.md):
  // loadIntegritySurface no longer computes its own total-spend figure (that
  // duplicated loadHeroMetrics's identical query when both ran together on
  // /reports) -- this route doesn't load hero metrics at all, so it resolves
  // the one query itself, same shape the loader used to run internally. Kept
  // as a direct top-level await (not Suspense-wrapped): it is a single-column
  // query, fast, and every section on this page needs it via
  // loadIntegritySurface anyway.
  const supabase = await createClient()
  const eventId = selectedEvent?.id ?? null
  const { data: spendRows, error: spendError } = await supabase
    .from('entries')
    .select('amount')
    .eq('event_id', eventId)
    .eq('is_void', false)
    .returns<{ amount: number | null }[]>()
  if (spendError) {
    // Best-effort, matching loadHeroMetrics'/loadIntegritySurface's own
    // never-throw-on-a-query-error convention -- 0 renders as "₹0", not a
    // crash; the waterfall section still shows its own row-level errors.
  }
  const totalSpend = round2Local((spendRows ?? []).reduce((s, r) => s + (r.amount ?? 0), 0))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Integrity</h1>
          {eventName && (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{eventName}</span>
          )}
        </div>
        <Link href="/reports" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          Full report &amp; drill workspace →
        </Link>
      </div>

      {isOverview ? (
        <>
          <p className="max-w-2xl text-sm text-muted-foreground">
            What the review function is working through: Hub-status ageing, the open exceptions and flags ranked by severity
            and ₹ at risk, the compliance &amp; leakage sweep, the exception heat map and amount-at-risk waterfall, open-item
            ageing, the duplicate-payment register, ledger vs bill reconciliation, entries with no supporting bill, and the
            two forensic tests — Benford&apos;s Law and round-number bias — plus threshold-splitting. Every figure links to
            the entries behind it; CSV export on every section.
          </p>
          <Suspense fallback={<SectionSkeleton />}>
            <IntegrityOverview compareBasis={compareBasis} totalSpend={totalSpend} selectedEvent={selectedEvent} />
          </Suspense>
        </>
      ) : (
        <>
          <Suspense fallback={<SectionSkeleton />}>
            <HubAgeingAndOpenIssuesGroup only={only} compareBasis={compareBasis} totalSpend={totalSpend} selectedEvent={selectedEvent} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <OpenItemAgeingGroup only={only} compareBasis={compareBasis} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <ComplianceAndRiskGroup only={only} compareBasis={compareBasis} totalSpend={totalSpend} selectedEvent={selectedEvent} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <DuplicateRegisterGroup only={only} compareBasis={compareBasis} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <ReconciliationGroup only={only} compareBasis={compareBasis} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <ForensicsGroup only={only} compareBasis={compareBasis} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <ThresholdSplittingGroup only={only} />
          </Suspense>
        </>
      )}
    </div>
  )
}

async function HubAgeingAndOpenIssuesGroup({
  only,
  compareBasis,
  totalSpend,
  selectedEvent,
}: {
  only: string | null
  compareBasis: CompareBasis
  totalSpend: number
  selectedEvent: Event | null
}) {
  if (groupHiddenInPane(only, ['hub-status-ageing', 'open-issues'])) return null
  const data = await getIntegritySurface(compareBasis, totalSpend, selectedEvent)
  return (
    <>
      {data.priorError && <p className="text-xs text-destructive">{data.priorError}</p>}
      {isSectionInPane(only, 'hub-status-ageing') && (
        <HubStatusAgeingSection
          rows={data.hubAgeing.rows}
          error={data.hubAgeing.error}
          compareBasis={compareBasis}
          buckets={data.hubAgeing.buckets}
          series={data.hubAgeing.series}
          previousCount={data.hubAgeing.previousCount}
        />
      )}
      {isSectionInPane(only, 'open-issues') && (
        <OpenIssuesSection
          rows={data.openIssues.rows}
          error={data.openIssues.error}
          compareBasis={compareBasis}
          series={data.openIssues.series}
          atRiskTotal={data.openIssues.atRiskTotal}
          previousAtRisk={data.openIssues.previousAtRisk}
        />
      )}
    </>
  )
}

async function OpenItemAgeingGroup({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['open-item-ageing'])) return null
  const spendOpen = await loadSpendCurveOpenAgeing(compareBasis)
  return (
    <OpenItemAgeingSection
      rows={spendOpen.openItemAgeing.rows}
      error={spendOpen.openItemAgeing.error}
      compareBasis={compareBasis}
      agedOpenCount={spendOpen.openItemAgeing.agedOpenCount}
      agedAmountAtRisk={spendOpen.openItemAgeing.agedAmountAtRisk}
      previousAgedOpenCount={spendOpen.openItemAgeing.previousAgedOpenCount}
    />
  )
}

async function ComplianceAndRiskGroup({
  only,
  compareBasis,
  totalSpend,
  selectedEvent,
}: {
  only: string | null
  compareBasis: CompareBasis
  totalSpend: number
  selectedEvent: Event | null
}) {
  if (groupHiddenInPane(only, ['compliance', 'exception-heatmap', 'amount-at-risk-waterfall'])) return null
  const data = await getIntegritySurface(compareBasis, totalSpend, selectedEvent)
  return (
    <>
      {isSectionInPane(only, 'compliance') && (
        <ComplianceSection
          rows={data.compliance.rows}
          error={data.compliance.error}
          compareBasis={compareBasis}
          series={data.compliance.series}
          atRiskTotal={data.compliance.atRiskTotal}
          byType={data.compliance.byType}
          previousAtRisk={data.compliance.previousAtRisk}
        />
      )}
      {isSectionInPane(only, 'exception-heatmap') && (
        <ExceptionHeatmapSection
          rows={data.exceptionHeatmap.rows}
          error={data.exceptionHeatmap.error}
          compareBasis={compareBasis}
          previousTotalAtRisk={data.exceptionHeatmap.previousTotalAtRisk}
        />
      )}
      {isSectionInPane(only, 'amount-at-risk-waterfall') && (
        <AmountAtRiskWaterfallSection
          rows={data.amountAtRiskWaterfall.rows}
          error={data.amountAtRiskWaterfall.error}
          totalSpend={data.amountAtRiskWaterfall.totalSpend}
        />
      )}
    </>
  )
}

async function DuplicateRegisterGroup({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['duplicate-payment-register'])) return null
  const dupRisk = await loadDuplicateVendorRisk(compareBasis)
  return (
    <DuplicatePaymentRegisterSection
      rows={dupRisk.duplicateRegister.rows}
      error={dupRisk.duplicateRegister.error}
      compareBasis={compareBasis}
      previousPreventedAmount={dupRisk.duplicateRegister.previousPreventedAmount}
    />
  )
}

async function ReconciliationGroup({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['ledger-bill-reconciliation', 'entries-without-bill'])) return null
  const recon = await loadReconciliationGap(compareBasis)
  return (
    <>
      {isSectionInPane(only, 'ledger-bill-reconciliation') && (
        <LedgerBillReconciliationSection
          rows={recon.ledgerBillReconciliation.rows}
          error={recon.ledgerBillReconciliation.error}
          histogram={recon.ledgerBillReconciliation.histogram}
          materialCount={recon.ledgerBillReconciliation.materialCount}
          materialAbsGapTotal={recon.ledgerBillReconciliation.materialAbsGapTotal}
          compareBasis={compareBasis}
          previousMaterialCount={recon.ledgerBillReconciliation.previousMaterialCount}
        />
      )}
      {isSectionInPane(only, 'entries-without-bill') && (
        <EntriesWithoutBillSection
          rows={recon.entriesWithoutBill.rows}
          error={recon.entriesWithoutBill.error}
          byDepartment={recon.entriesWithoutBill.byDepartment}
          byVendor={recon.entriesWithoutBill.byVendor}
          totalUndocumented={recon.entriesWithoutBill.totalUndocumented}
          noDocumentCount={recon.entriesWithoutBill.noDocumentCount}
          undocumentedPctOfSpend={recon.entriesWithoutBill.undocumentedPctOfSpend}
          compareBasis={compareBasis}
          previousTotalUndocumented={recon.entriesWithoutBill.previousTotalUndocumented}
        />
      )}
    </>
  )
}

async function ForensicsGroup({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['benford-digit-test', 'round-number-bias'])) return null
  const forensics = await loadAmountForensics(compareBasis)
  return (
    <>
      {isSectionInPane(only, 'benford-digit-test') && (
        <BenfordDigitTestSection
          rows={forensics.benford.rows}
          error={forensics.benford.error}
          mad={forensics.benford.mad}
          conformity={forensics.benford.conformity}
          totalCount={forensics.benford.totalCount}
          compareBasis={compareBasis}
          previousMad={forensics.benford.previousMad}
        />
      )}
      {isSectionInPane(only, 'round-number-bias') && (
        <RoundNumberBiasSection
          rows={forensics.roundNumber.rows}
          error={forensics.roundNumber.error}
          byDepartment={forensics.roundNumber.byDepartment}
          byVendor={forensics.roundNumber.byVendor}
          overallEntryCount={forensics.roundNumber.overallEntryCount}
          overallRoundCount={forensics.roundNumber.overallRoundCount}
          overallSharePct={forensics.roundNumber.overallSharePct}
          compareBasis={compareBasis}
          previousOverallSharePct={forensics.roundNumber.previousOverallSharePct}
        />
      )}
    </>
  )
}

async function ThresholdSplittingGroup({ only }: { only: string | null }) {
  if (groupHiddenInPane(only, ['threshold-splitting'])) return null
  const thresholdSplit = await loadThresholdSplitting()
  return (
    <ThresholdSplittingSection
      activeThresholds={thresholdSplit.activeThresholds}
      thresholdError={thresholdSplit.thresholdError}
      histogram={thresholdSplit.histogram}
      entryCount={thresholdSplit.entryCount}
      entriesError={thresholdSplit.entriesError}
      splittingFlags={thresholdSplit.splittingFlags}
      splittingFlagsError={thresholdSplit.splittingFlagsError}
    />
  )
}
