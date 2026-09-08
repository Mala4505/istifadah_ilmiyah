'use client'

/**
 * Always-present three-state ledger match strip (MASTER-PLAN §7). Replaces
 * the old `detail.billCount > 1` conditional in review-workspace.tsx --
 * every document, single-bill or not, needs a way to connect (or explicitly
 * decline to connect) a ledger entry from this screen.
 *
 * States, chosen purely from `attachedEntries`/`matchCandidates` (both already
 * computed server-side in app/(app)/review/page.tsx's loadDocumentDetail):
 *   - Linked: attachedEntries.length > 0.
 *   - Suggested: attachedEntries.length === 0 && matchCandidates.length > 0.
 *   - Unmatched: attachedEntries.length === 0 && matchCandidates.length === 0.
 *
 * Redesign plan §4: all three states now render through one
 * EntryAttachCombobox trigger (see that file's header) instead of separate
 * pill/text/button layouts -- Suggested and Unmatched only differ in whether
 * matchCandidates is passed through, so they share one render branch below.
 */

import { memo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { markNoEntryExpected } from '@/lib/actions/documents'
import { tallyWithinTolerance } from '@/lib/normalize'
import type { AttachedEntryView, MatchCandidate } from '@/lib/review/types'
import { formatINR } from '@/lib/reports/format'
import { EntryAttachCombobox } from './entry-attach-combobox'

// Perf 5.2: memo-wrapped so re-rendering its parent (ReviewStatusLine) for
// an unrelated prop change doesn't also re-render this combobox.
function MatchStripImpl({
  documentExtractionId,
  sourceDocumentId,
  attachedEntries,
  billTotal,
  entryDepartmentName,
  matchCandidates,
  onChanged,
  bare = false,
}: {
  documentExtractionId: number
  sourceDocumentId: number
  /** Every entry linked to this bill (Phase 5). Empty = no match yet. */
  attachedEntries: AttachedEntryView[]
  /** This bill's own total (coalesce(verified, ocr)) for the variance chip
   *  and the popover footer. Null suppresses both. */
  billTotal: number | null
  /** Primary linked entry's department -- only used for the single-entry
   *  label beside the trigger. */
  entryDepartmentName: string | null
  matchCandidates: MatchCandidate[]
  onChanged: () => void
  /** Redesign plan §4: when embedded inline in the Connect segment of
   * ReviewStatusLine, drop this component's own card chrome (border/bg/
   * padding) so it doesn't render as a nested card-in-a-card. Defaults to
   * false so any other render site keeps today's standalone-card look. */
  bare?: boolean
}) {
  const [markingNoEntry, setMarkingNoEntry] = useState(false)
  const cardClass = bare ? '' : 'rounded-md border border-border bg-background px-2 py-1.5'

  function handleNoEntryExpected() {
    setMarkingNoEntry(true)
    // Note: this writes source_document.match_status, a document-level
    // column -- there is no per-bill "no entry expected" flag in the
    // schema. On a multi-bill PDF this is a whole-document signal ("nothing
    // in this PDF matches"), not scoped to just this bill. Accepted,
    // deliberate scope limit (see the task brief); not fixed here.
    void markNoEntryExpected(sourceDocumentId).then((result) => {
      setMarkingNoEntry(false)
      if (!result.ok) {
        toastError(result.error, { context: 'match-strip' })
        return
      }
      toast.success('Marked -- no entry expected for this document.')
      onChanged()
    })
  }

  const noEntryButton = (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-6 shrink-0 px-1.5 text-xs text-muted-foreground"
      onClick={handleNoEntryExpected}
      disabled={markingNoEntry}
    >
      {markingNoEntry ? 'Marking…' : 'No entry expected'}
    </Button>
  )

  if (attachedEntries.length > 0) {
    const entryTotal = attachedEntries.reduce((sum, e) => sum + (e.amount ?? 0), 0)
    const diff = billTotal !== null ? billTotal - entryTotal : null
    const withinTolerance = billTotal !== null ? tallyWithinTolerance(billTotal, entryTotal) : null

    return (
      <div className={`flex flex-wrap items-center gap-2 text-sm ${cardClass}`}>
        <EntryAttachCombobox
          documentExtractionId={documentExtractionId}
          attachedEntries={attachedEntries}
          billTotal={billTotal}
          onAttached={onChanged}
          className="w-56"
        />
        {/* Highlight-only variance chip (plan §4). Never blocks Save or the
            control -- it just tells the reviewer whether the linked entries
            sum to the bill. */}
        {diff !== null && withinTolerance !== null ? (
          withinTolerance ? (
            <span
              className="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400"
              title="Linked entries match this bill within tolerance"
            >
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          ) : (
            <span
              className="flex shrink-0 items-center gap-1 text-xs font-medium text-destructive"
              title="Linked entries do not sum to this bill"
            >
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              {formatINR(Math.abs(diff))}
            </span>
          )
        ) : null}
        {attachedEntries.length === 1 && entryDepartmentName ? (
          <span className="truncate text-xs text-muted-foreground">{entryDepartmentName}</span>
        ) : null}
      </div>
    )
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 text-sm ${cardClass}`}>
      <EntryAttachCombobox
        documentExtractionId={documentExtractionId}
        attachedEntries={[]}
        billTotal={billTotal}
        suggestedCandidates={matchCandidates}
        onAttached={onChanged}
        className="w-56"
      />
      {noEntryButton}
    </div>
  )
}

export const MatchStrip = memo(MatchStripImpl)
