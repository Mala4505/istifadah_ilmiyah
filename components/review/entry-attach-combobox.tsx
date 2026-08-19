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
 * Only rendered when detail.billCount > 1 (review-workspace.tsx) --
 * single-bill documents keep matching via the existing document-inbox flow.
 */

import { useEffect, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { searchEntriesForAttach, type EntrySearchResult } from '@/lib/actions/documents'
import { attachExtractionToEntry } from '@/lib/actions/review'

export function EntryAttachCombobox({
  documentExtractionId,
  entryDisplayLabel,
  onAttached,
}: {
  documentExtractionId: number
  /** Currently-matched entry's display label (e.g. its UBBL number), or
   * null when this bill has no per-bill match yet. */
  entryDisplayLabel: string | null
  onAttached: () => void
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

  function handleSelect(entry: EntrySearchResult) {
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className="justify-between font-normal"
          onClick={() => setOpen(true)}
        >
          <span className="truncate">{entryDisplayLabel ?? 'Not attached -- attach to entry'}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
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
          ) : results.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {query.trim().length < 2 ? 'Type at least 2 characters to search.' : 'No entries found.'}
            </p>
          ) : (
            results.map((e) => (
              <button
                key={e.id}
                type="button"
                disabled={attaching !== null}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                onClick={() => handleSelect(e)}
              >
                {attaching === e.id ? <Check className="h-4 w-4 flex-shrink-0 animate-pulse" /> : <span className="w-4" />}
                <span className="flex-1 truncate">
                  {e.ubblNumber}
                  {e.vendorRaw ? ` · ${e.vendorRaw}` : ''}
                </span>
                {e.amount !== null ? <span className="text-xs text-muted-foreground">{e.amount}</span> : null}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
