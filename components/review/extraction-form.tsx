'use client'

/**
 * Split-pane's right half: header fields + line-items table (§7). Every
 * field is confidence-tinted with the SAME tint (document-level confidence,
 * §3.8 -- there is no per-field confidence stored). Field state is kept as
 * plain strings, parsed to numbers only at save time
 * (ReviewWorkspace.buildSavePayload) -- a controlled numeric `<input
 * type="number">` fights the user mid-keystroke on partial input like "12.",
 * and this screen's whole point is fast, uninterrupted typing.
 */

import type { Ref } from 'react'
import { forwardRef } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import type { ConfidenceTint } from '@/lib/review/types'
import type { VendorSearchResult } from '@/lib/actions/review'
import { VendorAutocomplete } from './vendor-autocomplete'

export interface HeaderFormState {
  vendorName: string
  vendorGstin: string
  vendorPhone: string
  vendorEmail: string
  vendorAddress: string
  invoiceNumber: string
  invoiceDate: string
  subtotal: string
  taxAmount: string
  totalAmount: string
  notes: string
}

export interface LineItemFormState {
  id: number
  description: string
  hsnSacCode: string
  quantity: string
  quantityRawText: string
  unit: string
  unitNormalized: string
  rate: string
  discount: string
  amount: string
}

const TINT_CLASSES: Record<ConfidenceTint, string> = {
  green: 'border-emerald-400 bg-emerald-50/70 focus-visible:ring-emerald-400 dark:border-emerald-700 dark:bg-emerald-950/30',
  amber: 'border-amber-400 bg-amber-50/70 focus-visible:ring-amber-400 dark:border-amber-700 dark:bg-amber-950/30',
  red: 'border-red-400 bg-red-50/70 focus-visible:ring-red-400 dark:border-red-700 dark:bg-red-950/30',
  none: '',
}

const UNIT_QUICK_PICKS = ['sqft', 'nos', 'day', 'kg', 'rft']

export const ExtractionForm = forwardRef(function ExtractionForm(
  {
    header,
    onHeaderChange,
    lineItems,
    onLineItemChange,
    tint,
    disabled,
    onFieldEnter,
    vendorId,
    vendorAutocompleteOpen,
    onVendorAutocompleteOpenChange,
    onVendorSelect,
  }: {
    header: HeaderFormState
    onHeaderChange: (field: keyof HeaderFormState, value: string) => void
    lineItems: LineItemFormState[]
    onLineItemChange: (id: number, field: keyof Omit<LineItemFormState, 'id'>, value: string) => void
    tint: ConfidenceTint
    disabled: boolean
    onFieldEnter: (target: HTMLElement) => void
    vendorId: number | null
    vendorAutocompleteOpen: boolean
    onVendorAutocompleteOpenChange: (open: boolean) => void
    onVendorSelect: (vendor: VendorSearchResult) => void
  },
  ref: Ref<HTMLDivElement>
) {
  const tintClass = TINT_CLASSES[tint]

  function handleEnter(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      onFieldEnter(e.currentTarget)
    }
  }

  return (
    <div ref={ref} className="flex h-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-1">
      <section className="grid grid-cols-2 gap-3 rounded-md border border-border p-3">
        <div className="col-span-2 flex flex-col gap-1.5">
          <Label>Vendor</Label>
          <VendorAutocomplete
            value={header.vendorName}
            selectedVendorId={vendorId}
            open={vendorAutocompleteOpen}
            onOpenChange={onVendorAutocompleteOpenChange}
            onSelect={onVendorSelect}
            fieldIndex={0}
          />
        </div>
        <Field label="GSTIN" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.vendorGstin} onChange={(v) => onHeaderChange('vendorGstin', v)} />
        <Field label="Phone" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.vendorPhone} onChange={(v) => onHeaderChange('vendorPhone', v)} />
        <Field label="Email" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.vendorEmail} onChange={(v) => onHeaderChange('vendorEmail', v)} />
        <div className="col-span-2">
          <Field label="Address" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
            value={header.vendorAddress} onChange={(v) => onHeaderChange('vendorAddress', v)} />
        </div>
        <Field label="Invoice number" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.invoiceNumber} onChange={(v) => onHeaderChange('invoiceNumber', v)} />
        <Field label="Invoice date" type="date" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.invoiceDate} onChange={(v) => onHeaderChange('invoiceDate', v)} />
        <Field label="Subtotal" inputMode="decimal" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.subtotal} onChange={(v) => onHeaderChange('subtotal', v)} />
        <Field label="Tax amount" inputMode="decimal" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.taxAmount} onChange={(v) => onHeaderChange('taxAmount', v)} />
        <Field label="Total amount" inputMode="decimal" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.totalAmount} onChange={(v) => onHeaderChange('totalAmount', v)} />
        <div className="col-span-2 flex flex-col gap-1.5">
          <Label>Notes</Label>
          <Textarea
            rows={2}
            disabled={disabled}
            className={tintClass}
            value={header.notes}
            onChange={(e) => onHeaderChange('notes', e.target.value)}
            onKeyDown={handleEnter}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">
          Line items <span className="text-xs">(press 1-9 to jump to a row)</span>
        </h3>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-1.5">#</th>
                <th className="px-2 py-1.5">Description</th>
                <th className="px-2 py-1.5">HSN/SAC</th>
                <th className="px-2 py-1.5">Qty</th>
                <th className="px-2 py-1.5">Qty (raw)</th>
                <th className="px-2 py-1.5">Unit</th>
                <th className="px-2 py-1.5">Rate</th>
                <th className="px-2 py-1.5">Discount</th>
                <th className="px-2 py-1.5">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((item, index) => {
                const jumpIndex = index < 9 ? index + 1 : null
                return (
                  <tr key={item.id} className="border-t border-border">
                    <td className="px-2 py-1 text-center text-xs text-muted-foreground">{index + 1}</td>
                    <td className="min-w-40 px-1 py-1">
                      <Input
                        data-line-jump-index={jumpIndex ?? undefined}
                        disabled={disabled}
                        className={tintClass}
                        value={item.description}
                        onChange={(e) => onLineItemChange(item.id, 'description', e.target.value)}
                        onKeyDown={handleEnter}
                      />
                    </td>
                    <td className="min-w-24 px-1 py-1">
                      <Input disabled={disabled} className={tintClass} value={item.hsnSacCode}
                        onChange={(e) => onLineItemChange(item.id, 'hsnSacCode', e.target.value)} onKeyDown={handleEnter} />
                    </td>
                    <td className="min-w-20 px-1 py-1">
                      <Input inputMode="decimal" disabled={disabled} className={tintClass} value={item.quantity}
                        onChange={(e) => onLineItemChange(item.id, 'quantity', e.target.value)} onKeyDown={handleEnter} />
                    </td>
                    <td className="min-w-28 px-1 py-1">
                      <Input disabled={disabled} className={tintClass} value={item.quantityRawText}
                        onChange={(e) => onLineItemChange(item.id, 'quantityRawText', e.target.value)} onKeyDown={handleEnter} />
                    </td>
                    <td className="min-w-32 px-1 py-1">
                      <Input disabled={disabled} className={tintClass} value={item.unitNormalized || item.unit}
                        onChange={(e) => onLineItemChange(item.id, 'unitNormalized', e.target.value)} onKeyDown={handleEnter} />
                      <div className="mt-1 flex gap-1">
                        {UNIT_QUICK_PICKS.map((u) => (
                          <button
                            key={u}
                            type="button"
                            disabled={disabled}
                            className="rounded border border-border px-1 text-[10px] text-muted-foreground hover:bg-accent"
                            onClick={() => onLineItemChange(item.id, 'unitNormalized', u)}
                          >
                            {u}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td className="min-w-24 px-1 py-1">
                      <Input inputMode="decimal" disabled={disabled} className={tintClass} value={item.rate}
                        onChange={(e) => onLineItemChange(item.id, 'rate', e.target.value)} onKeyDown={handleEnter} />
                    </td>
                    <td className="min-w-28 px-1 py-1">
                      <Input disabled={disabled} className={tintClass} value={item.discount}
                        onChange={(e) => onLineItemChange(item.id, 'discount', e.target.value)} onKeyDown={handleEnter} />
                    </td>
                    <td className="min-w-24 px-1 py-1">
                      <Input inputMode="decimal" disabled={disabled} className={tintClass} value={item.amount}
                        onChange={(e) => onLineItemChange(item.id, 'amount', e.target.value)} onKeyDown={handleEnter} />
                    </td>
                  </tr>
                )
              })}
              {lineItems.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-2 py-4 text-center text-sm text-muted-foreground">
                    No line items were extracted from this document.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
})

function Field({
  label,
  value,
  onChange,
  tintClass,
  disabled,
  type = 'text',
  inputMode,
  onKeyDown,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  tintClass: string
  disabled: boolean
  type?: string
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Input
        type={type}
        inputMode={inputMode}
        disabled={disabled}
        className={tintClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
