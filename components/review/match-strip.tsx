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

import { useState } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { markNoEntryExpected } from '@/lib/actions/documents'
import type { MatchCandidate } from '@/lib/review/types'
import { EntryAttachCombobox } from './entry-attach-combobox'

function formatMoney(n: number | null): string {
  if (n === null) return '—'
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

export function MatchStrip({
  documentExtractionId,
  sourceDocumentId,
  entryId,
  entryUbblNumber,
  entryVendorDisplayName,
  entryAmount,
  liveTotalAmount,
  matchCandidates,
  onChanged,
  bare = false,
}: {
  documentExtractionId: number
  sourceDocumentId: number
  entryId: number | null
  entryUbblNumber: string | null
  entryVendorDisplayName: string | null
  entryAmount: number | null
  /** The live (currently-typed, unsaved) form total, passed down from
   * review-workspace's state rather than re-derived here, so the strip
   * updates as the reviewer types instead of only after a save. */
  liveTotalAmount: number | null
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
    const variance = liveTotalAmount !== null && entryAmount !== null ? liveTotalAmount - entryAmount : null
    const varianceNote =
      variance === null
        ? null
        : Math.abs(variance) < 0.01
          ? { label: 'Matches', tint: 'text-emerald-700 dark:text-emerald-400' }
          : {
              label: `${variance > 0 ? '+' : ''}${formatMoney(variance)}`,
              tint: 'text-amber-700 dark:text-amber-400',
            }

    return (
      <div className={`flex flex-wrap items-center gap-2 text-sm ${cardClass}`}>
        <EntryAttachCombobox
          documentExtractionId={documentExtractionId}
          attachedLabel={`${entryUbblNumber ?? ''}${entryAmount !== null ? ` · RM ${formatMoney(entryAmount)}` : ''}`}
          onAttached={onChanged}
          className="w-56"
        />
        {entryVendorDisplayName ? <span className="truncate text-xs text-muted-foreground">{entryVendorDisplayName}</span> : null}
        {varianceNote ? <span className={`shrink-0 text-xs ${varianceNote.tint}`}>{varianceNote.label}</span> : null}
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
