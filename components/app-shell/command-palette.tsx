'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Command } from 'cmdk'
import { Loader2 } from 'lucide-react'
import { searchEntriesForAttach, type EntrySearchResult } from '@/lib/actions/documents'

// Local copy of the app's INR formatter (components/documents/format.ts,
// components/entries/format.ts) -- each feature folder keeps its own per the
// existing convention rather than reaching across features for a one-liner.
const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
})
function formatMoney(value: number | null): string {
  return value === null ? '—' : inrFormatter.format(value)
}

const MIN_QUERY_LENGTH = 2
const SEARCH_DEBOUNCE_MS = 200

// Cmd/Ctrl-K command palette (MASTER-PLAN §5 "Navigation" — jump to entry by
// UBBL, Main number, or invoice number). Reuses searchEntriesForAttach
// (lib/actions/documents.ts) rather than a second copy of the same
// UBBL/main/vendor/invoice OR-search -- it's already RLS-scoped and read-only
// for any active staff member, which is exactly this palette's access shape.
export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<EntrySearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const requestIdRef = useRef(0)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((current) => !current)
      }
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Reset search state on close so reopening (or jumping to a fresh page)
  // never flashes the previous query's results.
  useEffect(() => {
    if (!open) {
      setQuery('')
      setResults([])
      setSearched(false)
      setLoading(false)
    }
  }, [open])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([])
      setSearched(false)
      setLoading(false)
      return
    }
    setLoading(true)
    const requestId = ++requestIdRef.current
    const timeout = setTimeout(() => {
      void searchEntriesForAttach(trimmed).then((result) => {
        if (requestId !== requestIdRef.current) return // superseded by a newer keystroke
        setLoading(false)
        setSearched(true)
        setResults(result.ok ? result.results : [])
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timeout)
  }, [query])

  function goToEntry(entryId: number) {
    setOpen(false)
    router.push(`/entries/${entryId}`)
  }

  const trimmedQuery = query.trim()

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Jump to entry"
      shouldFilter={false}
      className="fixed left-1/2 top-24 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
    >
      <Command.Input
        value={query}
        onValueChange={setQuery}
        placeholder="Jump to entry by UBBL, Main number, or invoice number…"
        className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Command.List className="max-h-80 overflow-y-auto p-2">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Searching…
          </div>
        ) : trimmedQuery.length < MIN_QUERY_LENGTH ? (
          <Command.Empty className="px-2 py-8 text-center text-sm text-muted-foreground">
            Type at least {MIN_QUERY_LENGTH} characters to search.
          </Command.Empty>
        ) : searched && results.length === 0 ? (
          <Command.Empty className="px-2 py-8 text-center text-sm text-muted-foreground">
            No entries match “{trimmedQuery}”.
          </Command.Empty>
        ) : (
          results.map((entry) => (
            <Command.Item
              key={entry.id}
              value={String(entry.id)}
              onSelect={() => goToEntry(entry.id)}
              className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{entry.ubblNumber}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {[entry.mainNumber, entry.vendorRaw].filter(Boolean).join(' · ') || '—'}
                </span>
              </div>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatMoney(entry.amount)}</span>
            </Command.Item>
          ))
        )}
      </Command.List>
    </Command.Dialog>
  )
}
