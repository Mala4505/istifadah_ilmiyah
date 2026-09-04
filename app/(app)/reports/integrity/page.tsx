import Link from 'next/link'
import { getCompareBasis } from '@/lib/reports/compare-basis'
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
 */
export const dynamic = 'force-dynamic'

export default async function IntegritySurfacePage() {
  const compareBasis = await getCompareBasis()

  const [data, recon, forensics, spendOpen, dupRisk, thresholdSplit] = await Promise.all([
    loadIntegritySurface(compareBasis),
    loadReconciliationGap(compareBasis),
    loadAmountForensics(compareBasis),
    loadSpendCurveOpenAgeing(compareBasis),
    loadDuplicateVendorRisk(compareBasis),
    loadThresholdSplitting(),
  ])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Integrity</h1>
          {data.eventName && (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{data.eventName}</span>
          )}
        </div>
        <Link href="/reports" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          Full report &amp; drill workspace →
        </Link>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        What the review function is working through: Hub-status ageing, the open exceptions and flags ranked by severity and
        ₹ at risk, the compliance &amp; leakage sweep, the exception heat map and amount-at-risk waterfall, open-item ageing,
        the duplicate-payment register, ledger vs bill reconciliation, entries with no supporting bill, and the two forensic
        tests — Benford&apos;s Law and round-number bias — plus threshold-splitting. Every figure links to the entries behind
        it; CSV export on every section.
      </p>
      {data.priorError && <p className="text-xs text-destructive">{data.priorError}</p>}

      <HubStatusAgeingSection
        rows={data.hubAgeing.rows}
        error={data.hubAgeing.error}
        compareBasis={compareBasis}
        buckets={data.hubAgeing.buckets}
        series={data.hubAgeing.series}
        previousCount={data.hubAgeing.previousCount}
      />
      <OpenIssuesSection
        rows={data.openIssues.rows}
        error={data.openIssues.error}
        compareBasis={compareBasis}
        series={data.openIssues.series}
        atRiskTotal={data.openIssues.atRiskTotal}
        previousAtRisk={data.openIssues.previousAtRisk}
      />
      <OpenItemAgeingSection
        rows={spendOpen.openItemAgeing.rows}
        error={spendOpen.openItemAgeing.error}
        compareBasis={compareBasis}
        agedOpenCount={spendOpen.openItemAgeing.agedOpenCount}
        agedAmountAtRisk={spendOpen.openItemAgeing.agedAmountAtRisk}
        previousAgedOpenCount={spendOpen.openItemAgeing.previousAgedOpenCount}
      />
      <ComplianceSection
        rows={data.compliance.rows}
        error={data.compliance.error}
        compareBasis={compareBasis}
        series={data.compliance.series}
        atRiskTotal={data.compliance.atRiskTotal}
        byType={data.compliance.byType}
        previousAtRisk={data.compliance.previousAtRisk}
      />
      <ExceptionHeatmapSection
        rows={data.exceptionHeatmap.rows}
        error={data.exceptionHeatmap.error}
        compareBasis={compareBasis}
        previousTotalAtRisk={data.exceptionHeatmap.previousTotalAtRisk}
      />
      <AmountAtRiskWaterfallSection
        rows={data.amountAtRiskWaterfall.rows}
        error={data.amountAtRiskWaterfall.error}
        totalSpend={data.amountAtRiskWaterfall.totalSpend}
      />
      <DuplicatePaymentRegisterSection
        rows={dupRisk.duplicateRegister.rows}
        error={dupRisk.duplicateRegister.error}
        compareBasis={compareBasis}
        previousPreventedAmount={dupRisk.duplicateRegister.previousPreventedAmount}
      />
      <LedgerBillReconciliationSection
        rows={recon.ledgerBillReconciliation.rows}
        error={recon.ledgerBillReconciliation.error}
        histogram={recon.ledgerBillReconciliation.histogram}
        materialCount={recon.ledgerBillReconciliation.materialCount}
        materialAbsGapTotal={recon.ledgerBillReconciliation.materialAbsGapTotal}
        compareBasis={compareBasis}
        previousMaterialCount={recon.ledgerBillReconciliation.previousMaterialCount}
      />
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
      <BenfordDigitTestSection
        rows={forensics.benford.rows}
        error={forensics.benford.error}
        mad={forensics.benford.mad}
        conformity={forensics.benford.conformity}
        totalCount={forensics.benford.totalCount}
        compareBasis={compareBasis}
        previousMad={forensics.benford.previousMad}
      />
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
      <ThresholdSplittingSection
        activeThresholds={thresholdSplit.activeThresholds}
        thresholdError={thresholdSplit.thresholdError}
        histogram={thresholdSplit.histogram}
        entryCount={thresholdSplit.entryCount}
        entriesError={thresholdSplit.entriesError}
        splittingFlags={thresholdSplit.splittingFlags}
        splittingFlagsError={thresholdSplit.splittingFlagsError}
      />
    </div>
  )
}
