'use client'

/**
 * Per-bill entry-attach control (Phase 2, plan.md §3 "Matching"; multi-select
 * in Phase 5, entries<->bills M:N). A Popover + Button combobox trigger,
 * debounced search-as-you-type against searchEntriesForAttach
 * (lib/actions/documents.ts) -- but clicking a result now TOGGLES an
 * entry_bill_link (addBillEntryLink / detachExtractionFromEntry,
 * lib/actions/review.ts) instead of replacing a single scalar match, and the
 * popover stays open for the next pick.
 *
 * Redesign plan §4 folds match-strip.tsx's Matched/Suggested/Unmatched states
 * into this one trigger:
 *   - Linked: `attachedEntries` is non-empty -- the trigger shows the one
 *     entry's summary, or "N entries · <total>" for several.
 *   - Suggested: `attachedEntries` is empty but `suggestedCandidates` (ranked
 *     by the matcher) is non-empty -- the top candidate seeds the trigger's
 *     value (tagged "suggested") AND the popover's initial list.
 *   - Unmatched: both empty -- placeholder + search-only.
 * The popover pins a LINKED section (one row + ✕ per linked entry, plus a
 * bill-vs-entries variance footer) above the search box.
 */

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronsUpDown, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { tallyWithinTolerance } from '@/lib/normalize'
import { searchEntriesForAttach, type EntrySearchResult } from '@/lib/actions/documents'
import { addBillEntryLink, detachExtractionFromEntry } from '@/lib/actions/review'
import type { AttachedEntryView, MatchCandidate } from '@/lib/review/types'
import { formatINR } from '@/lib/reports/format'

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
  departmentName: string | null
}

export function EntryAttachCombobox({
  documentExtractionId,
  attachedEntries,
  billTotal,
  suggestedCandidates = [],
  onAttached,
  className,
}: {
  documentExtractionId: number
  /** Every entry currently linked to this bill (Phase 5), largest amount
   *  first. Empty when the bill has no match yet. */
  attachedEntries: AttachedEntryView[]
  /** This bill's own total (coalesce(verified, ocr)) for the popover's
   *  bill-vs-entries variance footer. Null hides the footer. */
  billTotal: number | null
  /** Ranked matcher candidates (empty when there are none) -- see file
   *  header for how this drives the trigger's value and the popover's
   *  initial list. Ignored once anything is linked. */
  suggestedCandidates?: MatchCandidate[]
  onAttached: () => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<EntrySearchResult[]>([])
  const [pending, setPending] = useState(false)
  // The entry id whose link is currently being toggled (added or removed), or
  // null. Disables every toggle affordance while one request is in flight.
  const [attaching, setAttaching] = useState<number | null>(null)
  // 5.8: same monotonic-request-id race guard as vendor-autocomplete.tsx --
  // a slow earlier search resolving after a newer one must not clobber the
  // newer, correct results. Bumped on every effect run that could produce a
  // result (including the "cleared back below 2 chars" branch, so a
  // still-in-flight fetch from before the clear can't land afterwards).
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setResults([])
  }, [open])

  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      requestIdRef.current++
      setResults([])
      return
    }
    const handle = setTimeout(() => {
      const requestId = ++requestIdRef.current
      setPending(true)
      void searchEntriesForAttach(query).then((r) => {
        if (requestIdRef.current !== requestId) return
        setResults(r.ok ? r.results : [])
        setPending(false)
      })
    }, 200)
    return () => clearTimeout(handle)
  }, [query, open])

  const linkedIds = new Set(attachedEntries.map((e) => e.entryId))

  // Toggle: not linked -> addBillEntryLink; already linked ->
  // detachExtractionFromEntry. The popover stays open (no setOpen(false)) so a
  // reviewer can pick several entries in one pass.
  function handleToggle(id: number, ubbl: string, isLinked: boolean) {
    setAttaching(id)
    const run = isLinked
      ? detachExtractionFromEntry({ documentExtractionId, entryId: id })
      : addBillEntryLink({ documentExtractionId, entryId: id })
    void run.then((result) => {
      setAttaching(null)
      if (!result.ok) {
        toastError(result.error, { context: 'entry-attach-combobox' })
        return
      }
      toast.success(isLinked ? `Unlinked ${ubbl}.` : `Linked to ${ubbl}.`)
      onAttached()
    })
  }

  function handleSelect(entry: AttachListItem) {
    handleToggle(entry.id, entry.ubblNumber, linkedIds.has(entry.id))
  }

  const top = suggestedCandidates[0] ?? null
  // Suggested-candidates seeding only applies while nothing is linked.
  const showingSuggestedList =
    attachedEntries.length === 0 && query.trim().length < 2 && suggestedCandidates.length > 0
  // Ranked candidates and searched entries carry the same fields under
  // different names (entryId vs id) -- normalise here so the results list
  // and handleSelect below don't need two code paths.
  const listResults: AttachListItem[] = showingSuggestedList
    ? suggestedCandidates.map((c) => ({
        id: c.entryId,
        ubblNumber: c.ubblNumber,
        vendorRaw: c.vendorRaw,
        amount: c.amount,
        departmentName: c.departmentName,
      }))
    : results.map((e) => ({
        id: e.id,
        ubblNumber: e.ubblNumber,
        vendorRaw: e.vendorRaw,
        amount: e.amount,
        departmentName: e.departmentName,
      }))

  const attachedCount = attachedEntries.length
  const attachedTotal = attachedEntries.reduce((sum, e) => sum + (e.amount ?? 0), 0)

  const triggerValue =
    attachedCount === 0
      ? top
        ? `${top.ubblNumber}${top.amount !== null ? ` · ${formatINR(top.amount)}` : ''}`
        : null
      : attachedCount === 1
        ? `${attachedEntries[0]!.ubblNumber}${
            attachedEntries[0]!.amount !== null ? ` · ${formatINR(attachedEntries[0]!.amount)}` : ''
          }`
        : `${attachedCount} entries · ${formatINR(attachedTotal)}`

  const footerDiff = billTotal !== null ? billTotal - attachedTotal : null

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
            {attachedCount === 0 && top ? (
              <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0 text-[10px] leading-4 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                suggested
              </span>
            ) : null}
          </span>
          <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2" align="start">
        {attachedEntries.length > 0 ? (
          <div className="mb-2 flex flex-col gap-1">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Linked
            </span>
            {attachedEntries.map((e) => (
              <div
                key={e.entryId}
                className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">
                  {e.ubblNumber}
                  {e.vendorRaw ? ` · ${e.vendorRaw}` : ''}
                  {e.amount !== null ? ` · ${formatINR(e.amount)}` : ''}
                </span>
                <button
                  type="button"
                  disabled={attaching !== null}
                  aria-label={`Unlink ${e.ubblNumber}`}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  onClick={() => handleToggle(e.entryId, e.ubblNumber, true)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {billTotal !== null && footerDiff !== null ? (
              <div className="mt-1 border-t border-border px-1 pt-1.5 text-xs tabular-nums">
                <span className="text-muted-foreground">bill </span>
                <span className="font-medium">{formatINR(billTotal)}</span>
                <span className="text-muted-foreground"> · entries </span>
                <span className="font-medium">{formatINR(attachedTotal)}</span>{' '}
                {tallyWithinTolerance(billTotal, attachedTotal) ? (
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">✓</span>
                ) : (
                  <span className="font-medium text-destructive">
                    {footerDiff >= 0 ? '+' : '−'}
                    {formatINR(Math.abs(footerDiff))}
                  </span>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
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
            listResults.map((e, i) => {
              const isLinked = linkedIds.has(e.id)
              return (
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
                  {attaching === e.id ? (
                    <Check className="h-4 w-4 flex-shrink-0 animate-pulse" />
                  ) : isLinked ? (
                    <Check className="h-4 w-4 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <span className="w-4" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">
                      {e.ubblNumber}
                      {e.vendorRaw ? ` · ${e.vendorRaw}` : ''}
                    </span>
                    {e.departmentName ? (
                      <span className="truncate text-xs text-muted-foreground">{e.departmentName}</span>
                    ) : null}
                  </span>
                  {e.amount !== null ? (
                    <span className="text-xs text-muted-foreground">{formatMoney(e.amount)}</span>
                  ) : null}
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
