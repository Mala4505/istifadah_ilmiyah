'use client'

/**
 * `/` -- vendor autocomplete (§7). Server-side search
 * (lib/actions/review.ts's searchReviewVendors, via the pg_trgm index) rather
 * than shipping the whole `vendor` table, per the task brief's preference
 * over components/admin/vendor-merge-panel.tsx's client-side-filter pattern
 * (fine for that screen's small curated list; not for a possibly-large
 * vendor table here).
 */

import { forwardRef, useEffect, useState, type Ref } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { searchReviewVendors, type VendorSearchResult } from '@/lib/actions/review'

export const VendorAutocomplete = forwardRef(function VendorAutocomplete(
  {
    value,
    selectedVendorId,
    onSelect,
    open,
    onOpenChange,
    fieldIndex,
  }: {
    /** Current display text -- usually the OCR/verified vendor_name field. */
    value: string
    selectedVendorId: number | null
    onSelect: (vendor: VendorSearchResult) => void
    open: boolean
    onOpenChange: (open: boolean) => void
    fieldIndex: number
  },
  ref: Ref<HTMLButtonElement>
) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<VendorSearchResult[]>([])
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) return
    setQuery(value ?? '')
  }, [open, value])

  useEffect(() => {
    if (!open) return
    const handle = setTimeout(() => {
      setPending(true)
      void searchReviewVendors(query).then((r) => {
        setResults(r)
        setPending(false)
      })
    }, 200)
    return () => clearTimeout(handle)
  }, [query, open])

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          ref={ref}
          type="button"
          variant="outline"
          role="combobox"
          data-field-index={fieldIndex}
          aria-expanded={open}
          className="w-full justify-between font-normal"
          onClick={() => onOpenChange(true)}
        >
          <span className="truncate">{value || 'Vendor not set'}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2" align="start">
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
