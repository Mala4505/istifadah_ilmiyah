'use client'

/**
 * Always-present three-state ledger match strip (MASTER-PLAN §7). Replaces
 * the old `detail.billCount > 1` conditional in review-workspace.tsx --
 * every document, single-bill or not, needs a way to connect (or explicitly
 * decline to connect) a ledger entry from this screen.
 *
 * States, chosen purely from `entryId`/`matchCandidates` (both already
 * computed server-side in app/(app)/review/page.tsx's loadDocumentDetail):
 *   - Matched: entryId !== null.
 *   - Suggested: entryId === null && matchCandidates.length > 0.
 *   - Unmatched: entryId === null && matchCandidates.length === 0.
 *
 * Redesign plan §4: all three states now render through one
 * EntryAttachCombobox trigger (see that file's header) instead of separate
 * pill/text/button layouts -- Suggested and Unmatched only differ in whether
 * matchCandidates is passed through, so they share one render branch below.
 */

import { memo, useState } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { markNoEntryExpected } from '@/lib/actions/documents'
import type { MatchCandidate } from '@/lib/review/types'
import { formatINR } from '@/lib/reports/format'
import { EntryAttachCombobox } from './entry-attach-combobox'

// Perf 5.2: memo-wrapped so re-rendering its parent (ReviewStatusLine) for
// an unrelated prop change doesn't also re-render this combobox.
function MatchStripImpl({
  documentExtractionId,
  sourceDocumentId,
  entryId,
  entryUbblNumber,
  entryDepartmentName,
  entryAmount,
  matchCandidates,
  onChanged,
  bare = false,
}: {
  documentExtractionId: number
  sourceDocumentId: number
  entryId: number | null
  entryUbblNumber: string | null
  entryDepartmentName: string | null
  entryAmount: number | null
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

  if (entryId !== null) {
    return (
      <div className={`flex flex-wrap items-center gap-2 text-sm ${cardClass}`}>
        <EntryAttachCombobox
          documentExtractionId={documentExtractionId}
          attachedLabel={`${entryUbblNumber ?? ''}${entryAmount !== null ? ` · ${formatINR(entryAmount)}` : ''}`}
          onAttached={onChanged}
          className="w-56"
        />
        {entryDepartmentName ? <span className="truncate text-xs text-muted-foreground">{entryDepartmentName}</span> : null}
      </div>
    )
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 text-sm ${cardClass}`}>
      <EntryAttachCombobox
        documentExtractionId={documentExtractionId}
        attachedLabel={null}
        suggestedCandidates={matchCandidates}
        onAttached={onChanged}
        className="w-56"
      />
      {noEntryButton}
    </div>
  )
}

export const MatchStrip = memo(MatchStripImpl)
