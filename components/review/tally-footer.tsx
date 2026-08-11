'use client'

/**
 * Live three-way tally footer (§7), recomputed on every keystroke by the
 * caller (ReviewWorkspace passes live numbers in, not row IDs) --
 * `tallyWithinTolerance` is imported here, not reimplemented, per the task
 * brief ("Use this, don't reimplement the math").
 */

import { CheckCircle2, AlertTriangle } from 'lucide-react'
import { tallyWithinTolerance } from '@/lib/normalize'
import { formatINR } from '@/lib/reports/format'

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
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-md border border-border bg-background px-4 py-2 text-sm">
      <TallyStat label="Line items" value={lineItemSum} />
      <TallyStat label="Document total" value={documentTotal} verdict={linesMatchTotal} />
      <div className="mx-1 h-5 w-px bg-border" />
      <TallyStat label="Entry (tenant)" value={entryAmount} />
      {entryVariance !== null ? (
        <span className="text-muted-foreground">variance {formatINR(Math.abs(entryVariance))}</span>
      ) : null}
      {totalMatchesEntry !== null ? (
        totalMatchesEntry ? (
          <span className="flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" /> within tolerance
          </span>
        ) : (
          <span className="flex items-center gap-1 font-medium text-destructive">
            <AlertTriangle className="h-4 w-4" /> outside tolerance
          </span>
        )
      ) : null}
    </div>
  )
}

function TallyStat({ label, value, verdict }: { label: string; value: number | null; verdict?: boolean | null }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{formatINR(value)}</span>
      {verdict === true ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : null}
      {verdict === false ? <AlertTriangle className="h-3.5 w-3.5 text-destructive" /> : null}
    </span>
  )
}
