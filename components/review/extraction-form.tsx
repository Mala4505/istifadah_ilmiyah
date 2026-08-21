'use client'

/**
 * Split-pane's right half: header fields + line-items table (§7). Document
 * confidence is a single toolbar badge (ReviewWorkspace) -- painting every
 * field the same tint trained reviewers to ignore it (plan L3). Field-level
 * colour here is reserved for two per-field conditions that actually vary
 * row to row: an OCR uncertainty flag (orange ring) and a value the reviewer
 * edited away from the OCR baseline (blue ring) -- see UNCERTAIN_RING_CLASS
 * / EDITED_RING_CLASS. Field state is kept as plain strings, parsed to
 * numbers only at save time (ReviewWorkspace.buildSavePayload) -- a
 * controlled numeric `<input type="number">` fights the user mid-keystroke
 * on partial input like "12.", and this screen's whole point is fast,
 * uninterrupted typing.
 */

import type { Ref } from 'react'
import { Fragment, forwardRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import type { UncertainField } from '@/lib/review/types'
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

const UNIT_QUICK_PICKS = ['sqft', 'nos', 'day', 'kg', 'rft']

/** A flagged field gets this ring -- an OCR-uncertainty flag takes priority
 * over an "edited from OCR" one (EDITED_RING_CLASS) when a field is both,
 * since the model doubting itself is the stronger signal to check. */
const UNCERTAIN_RING_CLASS = 'ring-2 ring-orange-500 ring-offset-1 dark:ring-offset-background'

/** A field the reviewer changed from its OCR baseline -- deliberately blue,
 * not red, since red/destructive is reserved for a future validation-error
 * state (plan L3, not built yet). Distinct from UNCERTAIN_RING_CLASS so
 * "the model wasn't sure" and "you changed this" never look like the same
 * thing. */
const EDITED_RING_CLASS = 'ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-background'

/** Per-field "differs from OCR" lookups, computed once in ReviewWorkspace
 * from `detail.header`/`detail.lineItems`' `.ocr` baselines against live form
 * state -- kept out of this component so it doesn't need the OCR baseline
 * threaded through as a second copy of header/lineItems. Line items are
 * keyed by `lineOrder`, matching `uncertainByLineOrder` below. */
export interface EditedFieldSets {
  header: Set<keyof HeaderFormState>
  lineItems: Map<number, Set<string>>
}

const EMPTY_EDITED_FIELDS: EditedFieldSets = { header: new Set(), lineItems: new Map() }

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
    disabled,
    onFieldEnter,
    vendorId,
    vendorAutocompleteOpen,
    onVendorAutocompleteOpenChange,
    onVendorSelect,
    uncertainFields = [],
    editedFields = EMPTY_EDITED_FIELDS,
    onJumpToPage,
  }: {
    header: HeaderFormState
    onHeaderChange: (field: keyof HeaderFormState, value: string) => void
    lineItems: LineItemFormState[]
    onLineItemChange: (id: number, field: keyof Omit<LineItemFormState, 'id'>, value: string) => void
    disabled: boolean
    onFieldEnter: (target: HTMLElement) => void
    vendorId: number | null
    vendorAutocompleteOpen: boolean
    onVendorAutocompleteOpenChange: (open: boolean) => void
    onVendorSelect: (vendor: VendorSearchResult) => void
    /** Fields the model doubted (document_extraction.uncertain_fields_ocr) — drives
     *  the orange ring and the "jump to page" affordance. */
    uncertainFields?: UncertainField[]
    /** Fields whose live value differs from its OCR baseline — drives the blue
     *  ring when a field isn't also flagged uncertain. */
    editedFields?: EditedFieldSets
    /** Called with a field's source page when a flagged field is clicked/focused. */
    onJumpToPage?: (pageNumber: number) => void
  },
  ref: Ref<HTMLDivElement>
) {
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

  function headerEdited(key: keyof HeaderFormState): boolean {
    return editedFields.header.has(key)
  }

  function lineItemEdited(lineOrder: number, key: string): boolean {
    return editedFields.lineItems.get(lineOrder)?.has(key) ?? false
  }

  // L2 (plan §10, checklist 3.11-3.13): a 12-line invoice was 108 inputs plus
  // 60 unit quick-picks on screen at once. HSN/SAC, Qty (raw) and Discount
  // are rarely touched, so they live behind a per-row expander -- seeded
  // open once per mount (this form remounts per document/extraction run,
  // see ReviewWorkspace's dirty-tracking comment) for rows where a hidden
  // field already differs from OCR or Discount carries an uncertainty flag,
  // then left entirely to manual toggling: auto-expand never re-collapses a
  // row the reviewer opened or closed by hand.
  const [expandedRows, setExpandedRows] = useState<Set<number>>(() => {
    const initial = new Set<number>()
    for (const item of lineItems) {
      const hiddenFieldEdited =
        lineItemEdited(item.lineOrder, 'hsnSacCode') ||
        lineItemEdited(item.lineOrder, 'quantityRawText') ||
        lineItemEdited(item.lineOrder, 'discount')
      if (hiddenFieldEdited || lineItemUncertainty(item.lineOrder, 'discount')) initial.add(item.id)
    }
    return initial
  })

  function toggleRow(id: number) {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Unit quick-picks (sqft/nos/day/kg/rft) render only for the focused row --
  // otherwise every row shows all five at once. Tracked at the row level
  // (React's synthetic focus/blur events bubble) rather than per-input: on
  // blur, only clear focus if it's leaving the row entirely.
  // `relatedTarget` still inside the same `data-row-id` covers both moving
  // within a row (e.g. the Unit input to a quick-pick button -- the classic
  // blur-before-click race) and moving between the main row and its
  // expander sub-row.
  const [focusedRowId, setFocusedRowId] = useState<number | null>(null)
  function handleRowBlur(rowId: number) {
    return (e: React.FocusEvent<HTMLElement>) => {
      const related = e.relatedTarget as HTMLElement | null
      if (related?.closest(`[data-row-id="${rowId}"]`)) return
      setFocusedRowId((cur) => (cur === rowId ? null : cur))
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
        <Field label="GSTIN" disabled={disabled} onKeyDown={handleEnter}
          value={header.vendorGstin} onChange={(v) => onHeaderChange('vendorGstin', v)}
          uncertain={headerUncertainty('vendorGstin')} edited={headerEdited('vendorGstin')} onJumpToPage={onJumpToPage} />
        <Field label="Phone" disabled={disabled} onKeyDown={handleEnter}
          value={header.vendorPhone} onChange={(v) => onHeaderChange('vendorPhone', v)}
          uncertain={headerUncertainty('vendorPhone')} edited={headerEdited('vendorPhone')} onJumpToPage={onJumpToPage} />
        <Field label="Email" disabled={disabled} onKeyDown={handleEnter}
          value={header.vendorEmail} onChange={(v) => onHeaderChange('vendorEmail', v)}
          uncertain={headerUncertainty('vendorEmail')} edited={headerEdited('vendorEmail')} onJumpToPage={onJumpToPage} />
        <div className="col-span-2">
          <Field label="Address" disabled={disabled} onKeyDown={handleEnter}
            value={header.vendorAddress} onChange={(v) => onHeaderChange('vendorAddress', v)}
            uncertain={headerUncertainty('vendorAddress')} edited={headerEdited('vendorAddress')} onJumpToPage={onJumpToPage} />
        </div>
        <Field label="Invoice number" disabled={disabled} onKeyDown={handleEnter}
          value={header.invoiceNumber} onChange={(v) => onHeaderChange('invoiceNumber', v)}
          uncertain={headerUncertainty('invoiceNumber')} edited={headerEdited('invoiceNumber')} onJumpToPage={onJumpToPage} />
        <Field label="Invoice date" type="date" disabled={disabled} onKeyDown={handleEnter}
          value={header.invoiceDate} onChange={(v) => onHeaderChange('invoiceDate', v)}
          uncertain={headerUncertainty('invoiceDate')} edited={headerEdited('invoiceDate')} onJumpToPage={onJumpToPage} />
        <Field label="Subtotal" inputMode="decimal" disabled={disabled} onKeyDown={handleEnter}
          value={header.subtotal} onChange={(v) => onHeaderChange('subtotal', v)}
          uncertain={headerUncertainty('subtotal')} edited={headerEdited('subtotal')} onJumpToPage={onJumpToPage} />
        <Field label="Tax amount" inputMode="decimal" disabled={disabled} onKeyDown={handleEnter}
          value={header.taxAmount} onChange={(v) => onHeaderChange('taxAmount', v)}
          uncertain={headerUncertainty('taxAmount')} edited={headerEdited('taxAmount')} onJumpToPage={onJumpToPage} />
        <Field label="Total amount" inputMode="decimal" disabled={disabled} onKeyDown={handleEnter}
          value={header.totalAmount} onChange={(v) => onHeaderChange('totalAmount', v)}
          uncertain={headerUncertainty('totalAmount')} edited={headerEdited('totalAmount')} onJumpToPage={onJumpToPage} />
        <div className="col-span-2 flex flex-col gap-1.5">
          <Label>
            Notes
            {headerEdited('notes') ? (
              <span className="ml-1 text-blue-500" title="Edited from the original OCR value">
                ●
              </span>
            ) : null}
          </Label>
          <Textarea
            rows={2}
            disabled={disabled}
            className={headerEdited('notes') ? EDITED_RING_CLASS : ''}
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
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="w-14 px-2 py-1.5">#</th>
                <th className="px-2 py-1.5">Description</th>
                <th className="px-2 py-1.5">Qty</th>
                <th className="px-2 py-1.5">Unit</th>
                <th className="px-2 py-1.5">Rate</th>
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
                const ringClass = (uncertain: UncertainField | undefined, editedKey: string) =>
                  uncertain ? UNCERTAIN_RING_CLASS : lineItemEdited(item.lineOrder, editedKey) ? EDITED_RING_CLASS : ''
                const titleFor = (uncertain: UncertainField | undefined, editedKey: string) =>
                  uncertain
                    ? 'Model was uncertain about this value — click to jump to the source page'
                    : lineItemEdited(item.lineOrder, editedKey)
                      ? 'Edited from the original OCR value'
                      : undefined
                const expanded = expandedRows.has(item.id)
                const rowFocusProps = {
                  'data-row-id': item.id,
                  onFocus: () => setFocusedRowId(item.id),
                  onBlur: handleRowBlur(item.id),
                }
                return (
                  <Fragment key={item.id}>
                    <tr className="border-t border-border" {...rowFocusProps}>
                      <td className="px-1 py-1 text-center">
                        {/* preventDefault on mousedown stops this button from taking focus --
                            otherwise clicking it bubbles into the row's onFocus, revealing this
                            row's unit quick-picks and growing the row between mousedown and
                            mouseup, which can shift the button out from under a real click. */}
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => toggleRow(item.id)}
                          aria-expanded={expanded}
                          aria-label={expanded ? 'Collapse HSN/SAC, Qty (raw) and Discount' : 'Expand HSN/SAC, Qty (raw) and Discount'}
                          className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <ChevronRight className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                          {index + 1}
                        </button>
                      </td>
                      <td className="min-w-40 px-1 py-1">
                        <Input
                          data-line-jump-index={jumpIndex ?? undefined}
                          disabled={disabled}
                          className={ringClass(descUncertain, 'description')}
                          title={titleFor(descUncertain, 'description')}
                          onFocus={() => descUncertain && onJumpToPage?.(descUncertain.pageNumber)}
                          value={item.description}
                          onChange={(e) => onLineItemChange(item.id, 'description', e.target.value)}
                          onKeyDown={handleEnter}
                        />
                      </td>
                      <td className="min-w-20 px-1 py-1">
                        <Input inputMode="decimal" disabled={disabled}
                          className={ringClass(qtyUncertain, 'quantity')}
                          title={titleFor(qtyUncertain, 'quantity')}
                          onFocus={() => qtyUncertain && onJumpToPage?.(qtyUncertain.pageNumber)}
                          value={item.quantity}
                          onChange={(e) => onLineItemChange(item.id, 'quantity', e.target.value)} onKeyDown={handleEnter} />
                      </td>
                      <td className="min-w-32 px-1 py-1">
                        <Input disabled={disabled} className={ringClass(undefined, 'unitNormalized')}
                          title={titleFor(undefined, 'unitNormalized')} value={item.unitNormalized || item.unit}
                          onChange={(e) => onLineItemChange(item.id, 'unitNormalized', e.target.value)} onKeyDown={handleEnter} />
                        {focusedRowId === item.id ? (
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
                        ) : null}
                      </td>
                      <td className="min-w-24 px-1 py-1">
                        <Input inputMode="decimal" disabled={disabled}
                          className={ringClass(rateUncertain, 'rate')}
                          title={titleFor(rateUncertain, 'rate')}
                          onFocus={() => rateUncertain && onJumpToPage?.(rateUncertain.pageNumber)}
                          value={item.rate}
                          onChange={(e) => onLineItemChange(item.id, 'rate', e.target.value)} onKeyDown={handleEnter} />
                      </td>
                      <td className="min-w-24 px-1 py-1">
                        <Input inputMode="decimal" disabled={disabled}
                          className={ringClass(amountUncertain, 'amount')}
                          title={titleFor(amountUncertain, 'amount')}
                          onFocus={() => amountUncertain && onJumpToPage?.(amountUncertain.pageNumber)}
                          value={item.amount}
                          onChange={(e) => onLineItemChange(item.id, 'amount', e.target.value)} onKeyDown={handleEnter} />
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="border-t border-border/60 bg-muted/20" {...rowFocusProps}>
                        <td colSpan={6} className="px-2 py-1.5">
                          <div className="flex flex-wrap gap-3">
                            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                              HSN/SAC
                              <Input disabled={disabled} className={`w-28 ${ringClass(undefined, 'hsnSacCode')}`}
                                title={titleFor(undefined, 'hsnSacCode')} value={item.hsnSacCode}
                                onChange={(e) => onLineItemChange(item.id, 'hsnSacCode', e.target.value)} onKeyDown={handleEnter} />
                            </label>
                            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                              Qty (raw)
                              <Input disabled={disabled} className={`w-32 ${ringClass(undefined, 'quantityRawText')}`}
                                title={titleFor(undefined, 'quantityRawText')} value={item.quantityRawText}
                                onChange={(e) => onLineItemChange(item.id, 'quantityRawText', e.target.value)} onKeyDown={handleEnter} />
                            </label>
                            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                              Discount
                              <Input disabled={disabled} className={`w-28 ${ringClass(discountUncertain, 'discount')}`}
                                title={titleFor(discountUncertain, 'discount')}
                                onFocus={() => discountUncertain && onJumpToPage?.(discountUncertain.pageNumber)}
                                value={item.discount}
                                onChange={(e) => onLineItemChange(item.id, 'discount', e.target.value)} onKeyDown={handleEnter} />
                            </label>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
              {lineItems.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-2 py-4 text-center text-sm text-muted-foreground">
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
  disabled,
  type = 'text',
  inputMode,
  onKeyDown,
  uncertain,
  edited = false,
  onJumpToPage,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
  type?: string
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
  /** Present when this field was flagged in uncertain_fields_ocr. */
  uncertain?: UncertainField
  /** True when the live value differs from its OCR baseline. */
  edited?: boolean
  onJumpToPage?: (pageNumber: number) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>
        {label}
        {uncertain ? <span className="ml-1 text-orange-500" title="Model was uncertain about this value">●</span> : null}
        {!uncertain && edited ? (
          <span className="ml-1 text-blue-500" title="Edited from the original OCR value">●</span>
        ) : null}
      </Label>
      <Input
        type={type}
        inputMode={inputMode}
        disabled={disabled}
        className={uncertain ? UNCERTAIN_RING_CLASS : edited ? EDITED_RING_CLASS : ''}
        title={
          uncertain
            ? 'Model was uncertain about this value — click to jump to the source page'
            : edited
              ? 'Edited from the original OCR value'
              : undefined
        }
        onFocus={() => uncertain && onJumpToPage?.(uncertain.pageNumber)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
