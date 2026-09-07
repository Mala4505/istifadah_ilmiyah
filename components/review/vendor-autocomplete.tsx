'use client'

/**
 * `/` -- vendor autocomplete (§7). Server-side search
 * (lib/actions/review.ts's searchReviewVendors, via the pg_trgm index) rather
 * than shipping the whole `vendor` table, per the task brief's preference
 * over components/admin/vendor-merge-panel.tsx's client-side-filter pattern
 * (fine for that screen's small curated list; not for a possibly-large
 * vendor table here).
 */

import { forwardRef, useEffect, useRef, useState, type Ref } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { searchReviewVendors, type VendorSearchResult } from '@/lib/actions/review'

/** Matches extraction-form.tsx's UNCERTAIN_RING_CLASS -- kept local since
 *  that constant isn't exported, and this is the one non-Field/non-table
 *  input that needs the same orange-ring convention. */
const UNCERTAIN_RING_CLASS = 'ring-2 ring-orange-500 ring-offset-1 dark:ring-offset-background'

/** Matches extraction-form.tsx's UNCERTAIN_OFF_PAGE_CLASS (event-scoping-
 *  and-review-fixes-plan.md §2.7/§2.8) -- same local-copy reasoning as
 *  UNCERTAIN_RING_CLASS above. */
const UNCERTAIN_OFF_PAGE_CLASS = 'ring-1 ring-orange-300 opacity-60 dark:ring-orange-800'

export const VendorAutocomplete = forwardRef(function VendorAutocomplete(
  {
    value,
    searchSeed,
    selectedVendorId,
    onSelect,
    open,
    onOpenChange,
    fieldIndex,
    disabled = false,
    uncertain = false,
    uncertainIndex,
    onCurrentPage = true,
    onFocus,
  }: {
    /** Trigger label -- the linked vendor's own name, or '' when nothing is
     *  linked (split vendor UI: the vendor_name transcription is edited in its
     *  own field now, not here). */
    value: string
    /** What to prefill the search box with when the popover opens -- the OCR/
     *  edited vendor_name, so linking is usually one keystroke-free glance.
     *  Falls back to `value` when not given. */
    searchSeed?: string
    selectedVendorId: number | null
    onSelect: (vendor: VendorSearchResult) => void
    open: boolean
    onOpenChange: (open: boolean) => void
    fieldIndex: number
    /** Claim/past-event lock: greys the trigger and stops the popover opening,
     *  matching the rest of the form under `formDisabled`. */
    disabled?: boolean
    /** True when vendor_name was flagged in uncertain_fields_ocr -- draws
     *  the orange ring on the trigger button. */
    uncertain?: boolean
    /** This field's position in the uncertainFields array, rendered as
     *  data-uncertain-index for the toolbar's next/previous stepper. */
    uncertainIndex?: number
    /** §2.7/§2.8: whether the flagged field's source page matches the PDF
     *  page currently on screen -- irrelevant when `uncertain` is false.
     *  Defaults true so the ring reads as before this feature existed unless
     *  the caller says otherwise. */
    onCurrentPage?: boolean
    /** Called when the trigger button is focused while flagged uncertain --
     *  the caller uses this to jump the PDF pane to the source page. */
    onFocus?: () => void
  },
  ref: Ref<HTMLButtonElement>
) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<VendorSearchResult[]>([])
  const [pending, setPending] = useState(false)

  // "Create + link a vendor when none is linked" (2026-09-07): nothing is
  // linked yet, but there's a vendor name to work from -- saveVerification
  // (lib/actions/review.ts) will create + link a new unconfirmed vendor from
  // that name on save. Surface that here so "Not linked" + "No vendors found"
  // doesn't read as a dead end; no row is created until the reviewer saves.
  const pendingVendorName = (searchSeed ?? value ?? '').trim()
  const willCreateOnSave = selectedVendorId === null && !value && pendingVendorName !== ''
  // 5.8: monotonic request id -- a debounced search that resolves after a
  // newer one (e.g. a slow first keystroke's request outliving a fast
  // second one) must not overwrite the newer, correct results. Bumped
  // synchronously right before each fetch fires; a resolution only applies
  // itself when its own id still matches the latest.
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (!open) return
    setQuery(searchSeed ?? value ?? '')
  }, [open, value, searchSeed])

  useEffect(() => {
    if (!open) return
    const handle = setTimeout(() => {
      const requestId = ++requestIdRef.current
      setPending(true)
      void searchReviewVendors(query).then((r) => {
        if (requestIdRef.current !== requestId) return
        setResults(r)
        setPending(false)
      })
    }, 200)
    return () => clearTimeout(handle)
  }, [query, open])

  return (
    <Popover open={open && !disabled} onOpenChange={(next) => onOpenChange(disabled ? false : next)}>
      <PopoverTrigger asChild>
        <Button
          ref={ref}
          type="button"
          variant="outline"
          role="combobox"
          disabled={disabled}
          data-field-index={fieldIndex}
          data-uncertain-index={uncertainIndex}
          aria-expanded={open}
          className={cn(
            'w-full justify-between font-normal',
            uncertain && (onCurrentPage ? UNCERTAIN_RING_CLASS : UNCERTAIN_OFF_PAGE_CLASS),
            willCreateOnSave && !uncertain && 'border-dashed border-amber-400 dark:border-amber-600'
          )}
          title={
            uncertain
              ? onCurrentPage
                ? 'Model was uncertain about this value — click to jump to the source page'
                : 'Model was uncertain about this value, on another page — click to jump there'
              : willCreateOnSave
                ? `"${pendingVendorName}" isn't in the system yet — saving will create it as a new vendor and link it automatically. Open to link an existing vendor instead.`
                : undefined
          }
          onFocus={onFocus}
          onClick={() => !disabled && onOpenChange(true)}
        >
          <span className={cn('truncate', willCreateOnSave && 'text-amber-700 dark:text-amber-500')}>
            {value || (willCreateOnSave ? `New: ${pendingVendorName}` : 'Not linked')}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2" align="start">
        {willCreateOnSave && (
          <p className="mb-2 rounded bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            Not in the system yet. Link an existing vendor below, or just save — &ldquo;{pendingVendorName}&rdquo;
            will be created as a new vendor and linked automatically.
          </p>
        )}
        <Input
          autoFocus
          placeholder="Search vendors by name or GSTIN…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="mt-2 max-h-64 overflow-y-auto">
          {pending ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {query.trim().length < 2 ? 'Type at least 2 characters to search.' : 'No vendors found.'}
            </p>
          ) : (
            results.map((v) => (
              <button
                key={v.id}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  onSelect(v)
                  onOpenChange(false)
                }}
              >
                {selectedVendorId === v.id ? <Check className="h-4 w-4 flex-shrink-0" /> : <span className="w-4" />}
                <span className="flex-1 truncate">{v.displayName}</span>
                {v.gstin ? <span className="text-xs text-muted-foreground">{v.gstin}</span> : null}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
})
