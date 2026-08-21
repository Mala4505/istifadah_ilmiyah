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
import type { ConfidenceTint, UncertainField } from '@/lib/review/types'
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
  /** From document_extraction_line_item.line_order — the key uncertain_fields_ocr
   *  entries use to name a specific line item (stable across re-sorts, unlike
   *  the row's render index). */
  lineOrder: number
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

/** A flagged field gets this on top of its confidence tint — deliberately a
 * different visual channel (ring, not background) so "the whole document is
 * amber" and "this one field is uncertain" never look like the same thing. */
const UNCERTAIN_RING_CLASS = 'ring-2 ring-orange-500 ring-offset-1 dark:ring-offset-background'

/** Maps HeaderFormState's camelCase keys to the wire field names
 * UNCERTAIN_FIELD_NAMES uses (lib/extraction-schema.ts) — 'notes' has no
 * entry because it isn't part of that vocabulary (free-text commentary, not
 * a transcribed fact worth flagging). */
const HEADER_WIRE_FIELD: Partial<Record<keyof HeaderFormState, string>> = {
  vendorName: 'vendor_name',
  vendorGstin: 'vendor_gstin',
  vendorPhone: 'vendor_phone',
  vendorEmail: 'vendor_email',
  vendorAddress: 'vendor_address',
  invoiceNumber: 'invoice_number',
  invoiceDate: 'invoice_date',
  subtotal: 'subtotal',
  taxAmount: 'tax_amount',
  totalAmount: 'total_amount',
}

/** Same idea for line-item columns — only the ones UNCERTAIN_FIELD_NAMES
 * covers (description/quantity/rate/discount/amount); hsnSacCode, unit, etc.
 * are never flaggable. */
const LINE_ITEM_WIRE_FIELD: Partial<Record<keyof Omit<LineItemFormState, 'id'>, string>> = {
  description: 'line_item_description',
  quantity: 'line_item_quantity',
  rate: 'line_item_rate',
  discount: 'line_item_discount',
  amount: 'line_item_amount',
}

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
    uncertainFields = [],
    onJumpToPage,
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
    /** Fields the model doubted (document_extraction.uncertain_fields_ocr) — drives
     *  the ring highlight on top of `tint` and the "jump to page" affordance. */
    uncertainFields?: UncertainField[]
    /** Called with a field's source page when a flagged field is clicked/focused. */
    onJumpToPage?: (pageNumber: number) => void
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

  // header key -> the uncertain-field entry flagging it, if any.
  const uncertainHeaderByField = new Map<string, UncertainField>()
  // line_order -> (line-item wire field name -> entry).
  const uncertainByLineOrder = new Map<number, Map<string, UncertainField>>()
  for (const f of uncertainFields) {
    if (f.lineOrder === null) {
      uncertainHeaderByField.set(f.field, f)
    } else {
      if (!uncertainByLineOrder.has(f.lineOrder)) uncertainByLineOrder.set(f.lineOrder, new Map())
      uncertainByLineOrder.get(f.lineOrder)!.set(f.field, f)
    }
  }

  function headerUncertainty(key: keyof HeaderFormState): UncertainField | undefined {
    const wireField = HEADER_WIRE_FIELD[key]
    return wireField ? uncertainHeaderByField.get(wireField) : undefined
  }

  function lineItemUncertainty(lineOrder: number, key: keyof Omit<LineItemFormState, 'id'>): UncertainField | undefined {
    const wireField = LINE_ITEM_WIRE_FIELD[key]
    if (!wireField) return undefined
    return uncertainByLineOrder.get(lineOrder)?.get(wireField)
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
          value={header.vendorGstin} onChange={(v) => onHeaderChange('vendorGstin', v)}
          uncertain={headerUncertainty('vendorGstin')} onJumpToPage={onJumpToPage} />
        <Field label="Phone" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.vendorPhone} onChange={(v) => onHeaderChange('vendorPhone', v)}
          uncertain={headerUncertainty('vendorPhone')} onJumpToPage={onJumpToPage} />
        <Field label="Email" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.vendorEmail} onChange={(v) => onHeaderChange('vendorEmail', v)}
          uncertain={headerUncertainty('vendorEmail')} onJumpToPage={onJumpToPage} />
        <div className="col-span-2">
          <Field label="Address" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
            value={header.vendorAddress} onChange={(v) => onHeaderChange('vendorAddress', v)}
            uncertain={headerUncertainty('vendorAddress')} onJumpToPage={onJumpToPage} />
        </div>
        <Field label="Invoice number" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.invoiceNumber} onChange={(v) => onHeaderChange('invoiceNumber', v)}
          uncertain={headerUncertainty('invoiceNumber')} onJumpToPage={onJumpToPage} />
        <Field label="Invoice date" type="date" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.invoiceDate} onChange={(v) => onHeaderChange('invoiceDate', v)}
          uncertain={headerUncertainty('invoiceDate')} onJumpToPage={onJumpToPage} />
        <Field label="Subtotal" inputMode="decimal" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.subtotal} onChange={(v) => onHeaderChange('subtotal', v)}
          uncertain={headerUncertainty('subtotal')} onJumpToPage={onJumpToPage} />
        <Field label="Tax amount" inputMode="decimal" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.taxAmount} onChange={(v) => onHeaderChange('taxAmount', v)}
          uncertain={headerUncertainty('taxAmount')} onJumpToPage={onJumpToPage} />
        <Field label="Total amount" inputMode="decimal" tintClass={tintClass} disabled={disabled} onKeyDown={handleEnter}
          value={header.totalAmount} onChange={(v) => onHeaderChange('totalAmount', v)}
          uncertain={headerUncertainty('totalAmount')} onJumpToPage={onJumpToPage} />
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
                const descUncertain = lineItemUncertainty(item.lineOrder, 'description')
                const qtyUncertain = lineItemUncertainty(item.lineOrder, 'quantity')
                const rateUncertain = lineItemUncertainty(item.lineOrder, 'rate')
                const discountUncertain = lineItemUncertainty(item.lineOrder, 'discount')
                const amountUncertain = lineItemUncertainty(item.lineOrder, 'amount')
                return (
                  <tr key={item.id} className="border-t border-border">
                    <td className="px-2 py-1 text-center text-xs text-muted-foreground">{index + 1}</td>
                    <td className="min-w-40 px-1 py-1">
                      <Input
                        data-line-jump-index={jumpIndex ?? undefined}
                        disabled={disabled}
                        className={`${tintClass} ${descUncertain ? UNCERTAIN_RING_CLASS : ''}`}
                        title={descUncertain ? 'Model was uncertain about this value — click to jump to the source page' : undefined}
                        onFocus={() => descUncertain && onJumpToPage?.(descUncertain.pageNumber)}
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
                      <Input inputMode="decimal" disabled={disabled}
                        className={`${tintClass} ${qtyUncertain ? UNCERTAIN_RING_CLASS : ''}`}
                        title={qtyUncertain ? 'Model was uncertain about this value — click to jump to the source page' : undefined}
                        onFocus={() => qtyUncertain && onJumpToPage?.(qtyUncertain.pageNumber)}
                        value={item.quantity}
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
                      <Input inputMode="decimal" disabled={disabled}
                        className={`${tintClass} ${rateUncertain ? UNCERTAIN_RING_CLASS : ''}`}
                        title={rateUncertain ? 'Model was uncertain about this value — click to jump to the source page' : undefined}
                        onFocus={() => rateUncertain && onJumpToPage?.(rateUncertain.pageNumber)}
                        value={item.rate}
                        onChange={(e) => onLineItemChange(item.id, 'rate', e.target.value)} onKeyDown={handleEnter} />
                    </td>
                    <td className="min-w-28 px-1 py-1">
                      <Input disabled={disabled}
                        className={`${tintClass} ${discountUncertain ? UNCERTAIN_RING_CLASS : ''}`}
                        title={discountUncertain ? 'Model was uncertain about this value — click to jump to the source page' : undefined}
                        onFocus={() => discountUncertain && onJumpToPage?.(discountUncertain.pageNumber)}
                        value={item.discount}
                        onChange={(e) => onLineItemChange(item.id, 'discount', e.target.value)} onKeyDown={handleEnter} />
                    </td>
                    <td className="min-w-24 px-1 py-1">
                      <Input inputMode="decimal" disabled={disabled}
                        className={`${tintClass} ${amountUncertain ? UNCERTAIN_RING_CLASS : ''}`}
                        title={amountUncertain ? 'Model was uncertain about this value — click to jump to the source page' : undefined}
                        onFocus={() => amountUncertain && onJumpToPage?.(amountUncertain.pageNumber)}
                        value={item.amount}
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
  uncertain,
  onJumpToPage,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  tintClass: string
  disabled: boolean
  type?: string
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
  /** Present when this field was flagged in uncertain_fields_ocr. */
  uncertain?: UncertainField
  onJumpToPage?: (pageNumber: number) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>
        {label}
        {uncertain ? <span className="ml-1 text-orange-500" title="Model was uncertain about this value">●</span> : null}
      </Label>
      <Input
        type={type}
        inputMode={inputMode}
        disabled={disabled}
        className={`${tintClass} ${uncertain ? UNCERTAIN_RING_CLASS : ''}`}
        title={uncertain ? 'Model was uncertain about this value — click to jump to the source page' : undefined}
        onFocus={() => uncertain && onJumpToPage?.(uncertain.pageNumber)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
