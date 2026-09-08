'use client'

/**
 * Live two-card tally footer (plan §8), recomputed on every keystroke by the
 * caller (ReviewWorkspace passes live numbers in, not row IDs) --
 * `tallyWithinTolerance` is imported here, not reimplemented, per the task
 * brief ("Use this, don't reimplement the math").
 *
 * Redesign plan §8: replaces the old flat row of four unexplained stats
 * ("Line items," "Document total," "Entry (tenant)," a bare variance figure)
 * with two labeled cards, each carrying a permanent, always-visible one-line
 * caption in plain language -- not a hover-only tooltip most reviewers never
 * clicked. The tolerance rule's exact math is still dense enough to deserve
 * a supplementary hover-detail (Info icon), so that stays, but only as an
 * addition to the caption text, never a replacement for it.
 */

import { memo } from 'react'
import { CheckCircle2, AlertTriangle, Info } from 'lucide-react'
import { tallyWithinTolerance } from '@/lib/normalize'
import { formatINR } from '@/lib/reports/format'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const TOLERANCE_TOOLTIP =
  'Two amounts are "within tolerance" when their absolute difference is no more than the tighter of a ' +
  'flat ₹1 and 0.05% of the larger amount. In practice that caps at a flat ₹1 for any realistic invoice ' +
  '(above ~₹2,000); below that, the 0.05% bound is the tighter (stricter) one.'

// Perf 5.2: memo-wrapped -- pure presentation over three numbers the caller
// already memoizes (lineItemSum via 5.6), so re-renders should track those
// values changing, not every keystroke on an unrelated header field.
function TallyFooterImpl({
  lineItemSum,
  documentTotal,
  linkedEntryTotal,
  linkedEntryCount,
}: {
  lineItemSum: number | null
  documentTotal: number | null
  /** Phase 5: SUM of every linked entry's amount (from v_bill_entry_variance,
   *  a server figure -- not recomputed on keystroke). Null when nothing is
   *  linked / the read failed. */
  linkedEntryTotal: number | null
  /** How many entries are linked to this bill. */
  linkedEntryCount: number
}) {
  const linesMatchTotal =
    lineItemSum !== null && documentTotal !== null ? tallyWithinTolerance(lineItemSum, documentTotal) : null
  const totalMatchesEntry =
    documentTotal !== null && linkedEntryTotal !== null
      ? tallyWithinTolerance(documentTotal, linkedEntryTotal)
      : null
  const entryVariance =
    documentTotal !== null && linkedEntryTotal !== null ? documentTotal - linkedEntryTotal : null

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-background text-sm lg:flex-row lg:divide-x lg:divide-y-0">
        {/* Bill math -- line-item sum vs. this bill's own document total. */}
        <div className="flex flex-1 flex-col gap-1.5 px-4 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Bill math</span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <TallyStat label="Line items" value={lineItemSum} />
            <TallyStat label="Document total" value={documentTotal} verdict={linesMatchTotal} />
          </div>
          <p className="text-xs text-muted-foreground">
            Both numbers come from this bill&apos;s own pages — not a summary or cover page.
          </p>
        </div>

        {/* Compared to Entries -- this bill's total vs. the sum of every entry
            connected to it (Phase 5, entries<->bills M:N). */}
        <div className="flex flex-1 flex-col gap-1.5 px-4 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Compared to Entries
          </span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <TallyStat label="This bill" value={documentTotal} />
            <TallyStat
              label={`Entries linked (${linkedEntryCount})`}
              value={linkedEntryTotal}
            />
            {entryVariance !== null ? (
              <span className="text-muted-foreground">
                variance {entryVariance >= 0 ? '+' : '−'}
                {formatINR(Math.abs(entryVariance))}
              </span>
            ) : null}
            {totalMatchesEntry !== null ? (
              totalMatchesEntry ? (
                <span className="flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" /> within tolerance
                  <InfoTooltip text={TOLERANCE_TOOLTIP} />
                </span>
              ) : (
                <span className="flex items-center gap-1 font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4" /> outside tolerance
                  <InfoTooltip text={TOLERANCE_TOOLTIP} />
                </span>
              )
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Sums every entry connected to this bill and checks the total against this bill&apos;s own amount.
            A total shown before Verify is an OCR read, not a confirmed figure.
          </p>
        </div>
      </div>
    </TooltipProvider>
  )
}

export const TallyFooter = memo(TallyFooterImpl)

function InfoTooltip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="More info">
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  )
}

function TallyStat({
  label,
  value,
  verdict,
}: {
  label: string
  value: number | null
  verdict?: boolean | null
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{formatINR(value)}</span>
      {verdict === true ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : null}
      {verdict === false ? <AlertTriangle className="h-3.5 w-3.5 text-destructive" /> : null}
    </span>
  )
}
