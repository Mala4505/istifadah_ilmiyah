'use client'

/**
 * Per-bill entry-attach control (Phase 2, plan.md §3 "Matching"). Same
 * interaction shape as vendor-autocomplete.tsx -- a Popover + Button
 * combobox trigger, debounced search-as-you-type against a server action,
 * click a result to attach -- but searches `entries` via
 * searchEntriesForAttach (lib/actions/documents.ts, already built for the
 * document-inbox manual-match fallback) and writes through
 * attachExtractionToEntry (lib/actions/review.ts) instead of a vendor pick.
 *
 * Redesign plan §4 folds match-strip.tsx's Matched/Suggested/Unmatched
 * states into this one trigger instead of three different layouts:
 *   - Matched: `attachedLabel` is set, shown as the trigger's value.
 *   - Suggested: `attachedLabel` is null but `suggestedCandidates` (already
 *     ranked by the matcher) is non-empty -- the top candidate's summary
 *     becomes the trigger's value (tagged "suggested" so it reads as
 *     provisional) AND seeds the popover's result list before the reviewer
 *     types anything, so accepting it is just open + click, with typing to
 *     search something else always available.
 *   - Unmatched: both are empty/null -- trigger shows the placeholder, popover
 *     falls back to search-only (the original behaviour).
 * Same attach flow (attachExtractionToEntry) in every case -- only the
 * trigger's displayed value and the popover's starting list change.
 */

import { useEffect, useState } from 'react'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { searchEntriesForAttach, type EntrySearchResult } from '@/lib/actions/documents'
import { attachExtractionToEntry } from '@/lib/actions/review'
import type { MatchCandidate } from '@/lib/review/types'

function formatMoney(n: number | null): string {
  if (n === null) return '—'
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

// Only the fields the popover's result list and attach flow actually touch --
// EntrySearchResult carries extra fields (entryDepartmentId etc.) for other
// consumers that MatchCandidate has no equivalent of, so results from either
// source are narrowed to this shape before rendering.
interface AttachListItem {
  id: number
  ubblNumber: string
  vendorRaw: string | null
  amount: number | null
}

export function EntryAttachCombobox({
  documentExtractionId,
  attachedLabel,
  suggestedCandidates = [],
  onAttached,
  className,
}: {
  documentExtractionId: number
  /** Currently-attached entry's display label (e.g. "UBBL-2291 · RM
   * 4,820.00"), or null when this bill has no match yet. */
  attachedLabel: string | null
  /** Ranked matcher candidates (empty when there are none) -- see file
   * header for how this drives the trigger's value and the popover's
   * initial list. Ignored once `attachedLabel` is set. */
  suggestedCandidates?: MatchCandidate[]
  onAttached: () => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<EntrySearchResult[]>([])
  const [pending, setPending] = useState(false)
  const [attaching, setAttaching] = useState<number | null>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setResults([])
  }, [open])

  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setResults([])
      return
    }
    const handle = setTimeout(() => {
      setPending(true)
      void searchEntriesForAttach(query).then((r) => {
        setResults(r.ok ? r.results : [])
        setPending(false)
      })
    }, 200)
    return () => clearTimeout(handle)
  }, [query, open])

  function handleSelect(entry: AttachListItem) {
    setAttaching(entry.id)
    void attachExtractionToEntry({ documentExtractionId, entryId: entry.id }).then((result) => {
      setAttaching(null)
      if (!result.ok) {
        toastError(result.error, { context: 'entry-attach-combobox' })
        return
      }
      toast.success(`Attached to ${entry.ubblNumber}.`)
      setOpen(false)
      onAttached()
    })
  }

  const top = suggestedCandidates[0] ?? null
  const showingSuggestedList = query.trim().length < 2 && suggestedCandidates.length > 0
  // Ranked candidates and searched entries carry the same fields under
  // different names (entryId vs id) -- normalise here so the results list
  // and handleSelect below don't need two code paths.
  const listResults: AttachListItem[] = showingSuggestedList
    ? suggestedCandidates.map((c) => ({ id: c.entryId, ubblNumber: c.ubblNumber, vendorRaw: c.vendorRaw, amount: c.amount }))
    : results

  const triggerValue = attachedLabel
    ? attachedLabel
    : top
      ? `${top.ubblNumber}${top.amount !== null ? ` · RM ${formatMoney(top.amount)}` : ''}`
      : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className={cn(
            'h-8 w-48 justify-between gap-1.5 px-2 text-xs font-normal',
            !triggerValue && 'text-muted-foreground',
            className
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden="true" />
            <span className="truncate">{triggerValue ?? 'Not attached'}</span>
            {!attachedLabel && top ? (
              <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0 text-[10px] leading-4 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                suggested
              </span>
            ) : null}
          </span>
          <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2" align="start">
        <Input
          autoFocus
          placeholder="Search by UBBL, Main #, vendor, or invoice #…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="mt-2 max-h-64 overflow-y-auto">
          {pending ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">Searching…</p>
          ) : listResults.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {query.trim().length < 2 ? 'Type at least 2 characters to search.' : 'No entries found.'}
            </p>
          ) : (
            listResults.map((e, i) => (
              <button
                key={e.id}
                type="button"
                disabled={attaching !== null}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50',
                  showingSuggestedList && i === 0 && 'bg-accent/60'
                )}
                onClick={() => handleSelect(e)}
              >
                {attaching === e.id ? <Check className="h-4 w-4 flex-shrink-0 animate-pulse" /> : <span className="w-4" />}
                <span className="flex-1 truncate">
                  {e.ubblNumber}
                  {e.vendorRaw ? ` · ${e.vendorRaw}` : ''}
                </span>
                {e.amount !== null ? <span className="text-xs text-muted-foreground">{formatMoney(e.amount)}</span> : null}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
