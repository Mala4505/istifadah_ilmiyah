'use client'

/**
 * Always-present three-state ledger match strip (MASTER-PLAN §7). Replaces
 * the old `detail.billCount > 1` conditional in review-workspace.tsx --
 * every document, single-bill or not, needs a way to connect (or explicitly
 * decline to connect) a ledger entry from this screen.
 *
 * States, chosen purely from `entryId`/`matchCandidates` (both already
 * computed server-side in app/(app)/review/page.tsx's loadDocumentDetail):
 *   - Matched: entryId !== null -- static summary + live variance + "Change".
 *   - Suggested: entryId === null && matchCandidates.length > 0 -- one-click
 *     attach on the top candidate, "See N more" reveals the rest.
 *   - Unmatched: entryId === null && matchCandidates.length === 0 -- search
 *     (EntryAttachCombobox) + "No entry expected".
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { attachExtractionToEntry } from '@/lib/actions/review'
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
}) {
  const [expanded, setExpanded] = useState(false)
  const [attachingId, setAttachingId] = useState<number | null>(null)
  const [markingNoEntry, setMarkingNoEntry] = useState(false)

  function handleAttach(candidateEntryId: number, label: string) {
    setAttachingId(candidateEntryId)
    void attachExtractionToEntry({ documentExtractionId, entryId: candidateEntryId }).then((result) => {
      setAttachingId(null)
      if (!result.ok) {
        toastError(result.error, { context: 'match-strip' })
        return
      }
      toast.success(`Attached to ${label}.`)
      onChanged()
    })
  }

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

  if (entryId !== null) {
    const variance = liveTotalAmount !== null && entryAmount !== null ? liveTotalAmount - entryAmount : null
    const variances =
      variance === null
        ? null
        : Math.abs(variance) < 0.01
          ? { label: 'Matches form total', tint: 'text-emerald-700 dark:text-emerald-400' }
          : {
              label: `Variance: ${variance > 0 ? '+' : ''}${formatMoney(variance)}`,
              tint: 'text-amber-700 dark:text-amber-400',
            }

    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-sm">
        <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          Matched
        </span>
        <span className="font-medium">{entryUbblNumber}</span>
        {entryVendorDisplayName ? <span className="text-muted-foreground">{entryVendorDisplayName}</span> : null}
        <span className="text-muted-foreground">Ledger amount: {formatMoney(entryAmount)}</span>
        {variances ? <span className={`text-xs ${variances.tint}`}>{variances.label}</span> : null}
        <EntryAttachCombobox
          documentExtractionId={documentExtractionId}
          entryDisplayLabel={entryUbblNumber}
          triggerLabel="Change"
          triggerVariant="ghost"
          onAttached={onChanged}
        />
      </div>
    )
  }

  if (matchCandidates.length > 0) {
    const [top, ...rest] = matchCandidates
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Suggested match
          </span>
          <span className="font-medium">{top!.ubblNumber}</span>
          {top!.vendorRaw ? <span className="text-muted-foreground">{top!.vendorRaw}</span> : null}
          {top!.amount !== null ? <span className="text-muted-foreground">{formatMoney(top!.amount)}</span> : null}
          <span className="text-xs text-muted-foreground">score {Math.round(top!.score * 100)}%</span>
          <Button type="button" size="sm" onClick={() => handleAttach(top!.entryId, top!.ubblNumber)} disabled={attachingId !== null}>
            {attachingId === top!.entryId ? 'Attaching…' : 'Attach'}
          </Button>
          {rest.length > 0 ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Hide' : `See ${rest.length} more`}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={handleNoEntryExpected}
            disabled={markingNoEntry}
          >
            {markingNoEntry ? 'Marking…' : 'No entry expected'}
          </Button>
        </div>
        {expanded ? (
          <div className="flex flex-col gap-1.5 border-t border-border pt-2">
            {rest.map((c) => (
              <div key={c.entryId} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.ubblNumber}</span>
                {c.vendorRaw ? <span className="text-muted-foreground">{c.vendorRaw}</span> : null}
                {c.amount !== null ? <span className="text-muted-foreground">{formatMoney(c.amount)}</span> : null}
                <span className="text-xs text-muted-foreground">score {Math.round(c.score * 100)}%</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => handleAttach(c.entryId, c.ubblNumber)}
                  disabled={attachingId !== null}
                >
                  {attachingId === c.entryId ? 'Attaching…' : 'Attach'}
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs text-muted-foreground">Not it? Search instead:</span>
              <EntryAttachCombobox documentExtractionId={documentExtractionId} entryDisplayLabel={null} onAttached={onChanged} />
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-sm">
      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">Unmatched</span>
      <span className="text-muted-foreground">No ledger match yet.</span>
      <EntryAttachCombobox documentExtractionId={documentExtractionId} entryDisplayLabel={null} onAttached={onChanged} />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="ml-auto"
        onClick={handleNoEntryExpected}
        disabled={markingNoEntry}
      >
        {markingNoEntry ? 'Marking…' : 'No entry expected'}
      </Button>
    </div>
  )
}
