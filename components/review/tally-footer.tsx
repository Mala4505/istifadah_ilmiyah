'use client'

/**
 * Live three-way tally footer (§7), recomputed on every keystroke by the
 * caller (ReviewWorkspace passes live numbers in, not row IDs) --
 * `tallyWithinTolerance` is imported here, not reimplemented, per the task
 * brief ("Use this, don't reimplement the math").
 *
 * Info-icon tooltips (Item 7d) explain what each stat means and, for the
 * tolerance badge, state tallyWithinTolerance's actual rule verbatim rather
 * than a hand-written approximation -- see that function's doc comment in
 * lib/normalize.ts, which is the single source of truth this text is not
 * allowed to drift from.
 */

import { CheckCircle2, AlertTriangle, Info } from 'lucide-react'
import { tallyWithinTolerance } from '@/lib/normalize'
import { formatINR } from '@/lib/reports/format'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const ENTRY_TOOLTIP =
  'The amount recorded for this bill in the entries ledger (as entered by the department) — compared ' +
  "here against the invoice total your review confirms."
const VARIANCE_TOOLTIP = "The absolute difference between the document's total and the entry's recorded amount."
const TOLERANCE_TOOLTIP =
  'Two amounts are "within tolerance" when their absolute difference is no more than the tighter of a ' +
  'flat ₹1 and 0.05% of the larger amount. In practice that caps at a flat ₹1 for any realistic invoice ' +
  '(above ~₹2,000); below that, the 0.05% bound is the tighter (stricter) one.'
const LINE_ITEMS_TOOLTIP =
  "Whether the sum of every line item's amount matches the document's extracted subtotal/total, within " +
  'the same tolerance rule.'

export function TallyFooter({
  lineItemSum,
  documentTotal,
  entryAmount,
}: {
  lineItemSum: number | null
  documentTotal: number | null
  entryAmount: number | null
}) {
  const linesMatchTotal =
    lineItemSum !== null && documentTotal !== null ? tallyWithinTolerance(lineItemSum, documentTotal) : null
  const totalMatchesEntry =
    documentTotal !== null && entryAmount !== null ? tallyWithinTolerance(documentTotal, entryAmount) : null
  const entryVariance = documentTotal !== null && entryAmount !== null ? documentTotal - entryAmount : null

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-md border border-border bg-background px-4 py-2 text-sm">
        <TallyStat label="Line items" value={lineItemSum} />
        <TallyStat
          label="Document total"
          value={documentTotal}
          verdict={linesMatchTotal}
          infoText={LINE_ITEMS_TOOLTIP}
        />
        <div className="mx-1 h-5 w-px bg-border" />
        <TallyStat label="Entry (tenant)" value={entryAmount} infoText={ENTRY_TOOLTIP} />
        {entryVariance !== null ? (
          <span className="flex items-center gap-1 text-muted-foreground">
            variance {formatINR(Math.abs(entryVariance))}
            <InfoTooltip text={VARIANCE_TOOLTIP} />
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
    </TooltipProvider>
  )
}

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
  infoText,
}: {
  label: string
  value: number | null
  verdict?: boolean | null
  infoText?: string
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{formatINR(value)}</span>
      {verdict === true ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : null}
      {verdict === false ? <AlertTriangle className="h-3.5 w-3.5 text-destructive" /> : null}
      {infoText ? <InfoTooltip text={infoText} /> : null}
    </span>
  )
}
