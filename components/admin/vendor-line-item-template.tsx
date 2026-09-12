'use client'

/**
 * Per-vendor line-item template (20260912000001) -- the expanded content
 * under a vendor row in vendor-merge-panel.tsx. Lets an admin turn the
 * feature on/off for one vendor, seed a template from an already-reviewed
 * bill, and hand-edit the resulting ordered description list. Applied on the
 * review screen by components/review/review-workspace.tsx's
 * applyLineItemTemplate, which reads this same data via getVendorLineItemTemplate.
 */

import { useEffect, useState, useTransition } from 'react'
import { ArrowDown, ArrowUp, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  getBillLineItemsForSeeding,
  getVendorLineItemTemplate,
  listVerifiedBillsForVendor,
  type SeedBillLineItem,
  type VerifiedBillSummary,
} from '@/lib/actions/review'
import { saveVendorLineItemTemplate, setVendorTemplateEnabled } from '@/lib/actions/admin'
import type { VendorRow } from './vendor-merge-panel'

export function VendorLineItemTemplate({
  vendor,
  onEnabledChange,
}: {
  vendor: VendorRow
  /** Lets the parent row's own optimistic state (vendor.useLineItemTemplate) follow a toggle made in here, without a full vendor-list refetch. */
  onEnabledChange: (enabled: boolean) => void
}) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<string[]>([])
  const [savedRows, setSavedRows] = useState<string[]>([])
  const [seedOpen, setSeedOpen] = useState(false)
  const [isSaving, startSaving] = useTransition()
  const [isToggling, startToggling] = useTransition()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void getVendorLineItemTemplate(vendor.id).then((result) => {
      if (cancelled) return
      setRows(result.rows.map((r) => r.description))
      setSavedRows(result.rows.map((r) => r.description))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [vendor.id])

  function persist(nextRows: string[]) {
    setRows(nextRows)
    const descriptions = nextRows.map((d) => d.trim()).filter((d) => d.length > 0)
    startSaving(async () => {
      const result = await saveVendorLineItemTemplate({ vendorId: vendor.id, descriptions })
      if (result.ok) {
        // Tracks what's actually persisted (blanks filtered out), not the raw
        // editable rows -- a just-added blank row must stay visible in `rows`
        // for the reviewer to type into, but shouldn't count toward hasRows
        // or be what a failed save later reverts to.
        setSavedRows(descriptions)
      } else {
        toastError(result.error, { context: 'vendor-line-item-template' })
        setRows(savedRows)
      }
    })
  }

  function handleToggle(enabled: boolean) {
    onEnabledChange(enabled)
    startToggling(async () => {
      const result = await setVendorTemplateEnabled({ vendorId: vendor.id, enabled })
      if (!result.ok) {
        onEnabledChange(!enabled)
        toastError(result.error, { context: 'vendor-line-item-template' })
      }
    })
  }

  function updateRow(index: number, value: string) {
    setRows((current) => current.map((r, i) => (i === index ? value : r)))
  }

  function commitRow(index: number, value: string) {
    persist(rows.map((r, i) => (i === index ? value : r)))
  }

  function removeRow(index: number) {
    persist(rows.filter((_, i) => i !== index))
  }

  function moveRow(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= rows.length) return
    const next = [...rows]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    persist(next)
  }

  function addRow() {
    persist([...rows, ''])
  }

  const hasRows = savedRows.length > 0

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-4">
      <div className="flex items-start justify-between gap-4">
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={vendor.useLineItemTemplate}
            disabled={!hasRows || isToggling}
            onCheckedChange={(value) => handleToggle(value === true)}
          />
          <span>
            <span className="block font-medium">Use line-item template</span>
            <span className="block text-xs text-muted-foreground">
              {hasRows
                ? vendor.useLineItemTemplate
                  ? 'On — applied when this vendor is matched on a new bill.'
                  : 'Off — saved, but not applied to new bills.'
                : 'No template yet — seed one from a reviewed bill to enable this.'}
            </span>
          </span>
        </label>
        <Button type="button" variant="outline" size="sm" onClick={() => setSeedOpen(true)}>
          Seed from a reviewed bill…
        </Button>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading template…
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded border border-dashed p-3 text-center text-xs text-muted-foreground">
          No lines saved yet.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((description, index) => (
            <li key={index} className="flex items-center gap-1.5">
              <span className="w-5 shrink-0 text-right font-mono text-xs text-muted-foreground">{index + 1}</span>
              <Input
                value={description}
                onChange={(e) => updateRow(index, e.target.value)}
                onBlur={(e) => commitRow(index, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                className="h-8"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                disabled={index === 0}
                onClick={() => moveRow(index, -1)}
                aria-label="Move up"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                disabled={index === rows.length - 1}
                onClick={() => moveRow(index, 1)}
                aria-label="Move down"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => removeRow(index)}
                aria-label="Remove row"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button type="button" variant="ghost" size="sm" disabled={isSaving} onClick={addRow}>
        + Add row
      </Button>

      <SeedDialog
        vendor={vendor}
        open={seedOpen}
        onClose={() => setSeedOpen(false)}
        onSeeded={(descriptions) => {
          setRows(descriptions)
          setSavedRows(descriptions)
          onEnabledChange(true)
        }}
      />
    </div>
  )
}

function SeedDialog({
  vendor,
  open,
  onClose,
  onSeeded,
}: {
  vendor: VendorRow
  open: boolean
  onClose: () => void
  onSeeded: (descriptions: string[]) => void
}) {
  const [bills, setBills] = useState<VerifiedBillSummary[] | null>(null)
  const [selectedBill, setSelectedBill] = useState<VerifiedBillSummary | null>(null)
  const [lines, setLines] = useState<SeedBillLineItem[]>([])
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) return
    setSelectedBill(null)
    setLines([])
    setChecked(new Set())
    setBills(null)
    void listVerifiedBillsForVendor(vendor.id).then(setBills)
  }, [open, vendor.id])

  function handlePickBill(bill: VerifiedBillSummary) {
    setSelectedBill(bill)
    void getBillLineItemsForSeeding(bill.documentExtractionId).then((result) => {
      setLines(result)
      setChecked(new Set(result.map((_, i) => i)))
    })
  }

  function toggleLine(index: number) {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  function handleSave() {
    const descriptions = lines
      .filter((_, i) => checked.has(i))
      .map((l) => (l.description ?? '').trim())
      .filter((d) => d.length > 0)
    if (descriptions.length === 0) return

    startTransition(async () => {
      const result = await saveVendorLineItemTemplate({ vendorId: vendor.id, descriptions })
      if (!result.ok) {
        toastError(result.error, { context: 'vendor-line-item-template' })
        return
      }
      const enableResult = await setVendorTemplateEnabled({ vendorId: vendor.id, enabled: true })
      if (!enableResult.ok) {
        toastError(enableResult.error, { context: 'vendor-line-item-template' })
      }
      toast.success(`Saved a ${descriptions.length}-line template for "${vendor.displayName}".`)
      onSeeded(descriptions)
      onClose()
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Seed template from a reviewed bill</DialogTitle>
          <DialogDescription>
            Pick one of &quot;{vendor.displayName}&quot;&apos;s already-verified bills, then pick which lines to
            carry over. Only the description is saved — quantity, rate and amount will always be read fresh from
            every future bill.
          </DialogDescription>
        </DialogHeader>

        {!selectedBill ? (
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            {bills === null ? (
              <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading verified bills…
              </p>
            ) : bills.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                No verified bills found for this vendor yet.
              </p>
            ) : (
              bills.map((bill) => (
                <Button
                  key={bill.documentExtractionId}
                  type="button"
                  variant="outline"
                  className="flex w-full items-center justify-between"
                  onClick={() => handlePickBill(bill)}
                >
                  <span>
                    {bill.invoiceNumber ? `#${bill.invoiceNumber}` : `Bill ${bill.documentExtractionId}`}
                    {bill.entryDate ? ` · ${bill.entryDate}` : ''}
                  </span>
                  <span className="font-mono text-xs">
                    {bill.billTotal != null ? `₹${bill.billTotal.toLocaleString('en-IN')}` : '—'}
                  </span>
                </Button>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded border">
              {lines.map((line, index) => (
                <label
                  key={index}
                  className="flex items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0"
                >
                  <Checkbox checked={checked.has(index)} onCheckedChange={() => toggleLine(index)} />
                  <span>{line.description || <em className="text-muted-foreground">(blank)</em>}</span>
                </label>
              ))}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSelectedBill(null)} disabled={isPending}>
                Back
              </Button>
              <Button type="button" onClick={handleSave} disabled={isPending || checked.size === 0}>
                {isPending ? 'Saving…' : 'Save as template'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
