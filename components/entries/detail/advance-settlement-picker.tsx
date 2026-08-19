'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  searchAdvancePaymentEntries,
  setSettlesEntry,
  type AdvancePaymentSearchResult,
} from '@/lib/actions/entry-enrichment'
import { formatDate, formatMoney } from './format'
import type { AdvanceEntrySummary } from './types'

/**
 * §5 row 4: "The advance-settlement picker lives here." A simple
 * search/select popover over `type = 'advance_payment'` entries — kept
 * deliberately plain per the task brief ("doesn't need to be fancy").
 * Only applies to invoice-type entries; the caller decides whether to
 * render this at all.
 */
export function AdvanceSettlementPicker({
  entryId,
  departmentId,
  initialLinked,
}: {
  entryId: number
  departmentId: number | null
  initialLinked: AdvanceEntrySummary | null
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AdvancePaymentSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [linked, setLinked] = useState<AdvanceEntrySummary | null>(initialLinked)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    const handle = setTimeout(async () => {
      const rows = await searchAdvancePaymentEntries(query, departmentId)
      if (!cancelled) {
        setResults(rows)
        setLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [open, query, departmentId])

  function selectAdvance(row: AdvancePaymentSearchResult) {
    startTransition(async () => {
      const result = await setSettlesEntry(entryId, row.id)
      if (!result.success) {
        toastError(result.error, { title: 'Could not link advance.', context: 'advance-settlement-picker' })
        return
      }
      setLinked({
        id: row.id,
        ubbl_number: row.ubbl_number,
        vendor_display_name: row.vendor_display_name,
        vendor_raw: row.vendor_raw,
        amount: row.amount,
        date: row.date,
      })
      toast.success('Advance linked.')
      setOpen(false)
      router.refresh()
    })
  }

  function clearLink() {
    startTransition(async () => {
      const result = await setSettlesEntry(entryId, null)
      if (!result.success) {
        toastError(result.error, { title: 'Could not clear the advance link.', context: 'advance-settlement-picker' })
        return
      }
      setLinked(null)
      toast.success('Advance link cleared.')
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader className="space-y-0">
        <CardTitle className="text-base">Advance settlement</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {linked ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
            <div>
              <p className="font-medium">{linked.ubbl_number}</p>
              <p className="text-xs text-muted-foreground">
                {linked.vendor_display_name ?? linked.vendor_raw ?? 'Unknown vendor'} ·{' '}
                {formatMoney(linked.amount)} · {formatDate(linked.date)}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={clearLink} disabled={isPending}>
              Clear link
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Not linked to an advance payment. This invoice does not settle any advance.
          </p>
        )}

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="self-start">
              {linked ? 'Change linked advance' : 'Link an advance payment'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-96" align="start">
            <div className="flex flex-col gap-2">
              <Input
                autoFocus
                placeholder="Search UBBL number or vendor…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="max-h-72 overflow-y-auto">
                {loading && <p className="px-1 py-2 text-xs text-muted-foreground">Searching…</p>}
                {!loading && results.length === 0 && (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    No advance-payment entries match.
                  </p>
                )}
                {!loading &&
                  results.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => selectAdvance(row)}
                      disabled={isPending}
                      className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                    >
                      <span className="font-medium">{row.ubbl_number}</span>
                      <span className="text-xs text-muted-foreground">
                        {row.vendor_display_name ?? row.vendor_raw ?? 'Unknown vendor'} ·{' '}
                        {formatMoney(row.amount)} · {formatDate(row.date)}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </CardContent>
    </Card>
  )
}
