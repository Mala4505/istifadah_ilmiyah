'use client'

/**
 * Split-pane's right half: header fields + line-items table (§7). Document
 * confidence is a single toolbar badge (ReviewWorkspace) -- painting every
 * field the same tint trained reviewers to ignore it (plan L3). Field-level
 * colour here is reserved for three per-field conditions that actually vary
 * row to row, in priority order: a validation failure (red ring, checklist
 * 5.15 -- this value can't be parsed and will silently fail to save), an OCR
 * uncertainty flag (orange ring), and a value the reviewer edited away from
 * the OCR baseline (blue ring) -- see ERROR_RING_CLASS / UNCERTAIN_RING_CLASS
 * / EDITED_RING_CLASS. Field state is kept as plain strings, parsed to
 * numbers only at save time (ReviewWorkspace.buildSavePayload) -- a
 * controlled numeric `<input type="number">` fights the user mid-keystroke
 * on partial input like "12.", and this screen's whole point is fast,
 * uninterrupted typing.
 */

import type { Ref } from 'react'
import { Fragment, forwardRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
 * since the model doubting itself is the stronger signal to check. Beaten
 * only by ERROR_RING_CLASS below (checklist 5.15): a validation failure means
 * this value will silently fail to save, which is more urgent than either. */
const UNCERTAIN_RING_CLASS = 'ring-2 ring-orange-500 ring-offset-1 dark:ring-offset-background'

/** A field the reviewer changed from its OCR baseline. Distinct from
 * UNCERTAIN_RING_CLASS so "the model wasn't sure" and "you changed this"
 * never look like the same thing; beaten by both UNCERTAIN_RING_CLASS and
 * ERROR_RING_CLASS in priority. */
const EDITED_RING_CLASS = 'ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-background'

/** Checklist 5.15 (plan §13 V1): the validation-error state 3.3's comment
 * called out as "not built yet" -- an amount-shaped field whose text can't be
 * parsed as a number, which today saves as a silent null. Outranks both
 * UNCERTAIN_RING_CLASS and EDITED_RING_CLASS: a field that's both
 * model-uncertain AND unparseable shows red, since "this will silently lose
 * data" beats "the model wasn't sure." */
const ERROR_RING_CLASS = 'ring-2 ring-red-500 ring-offset-1 dark:ring-offset-background'

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

/** Checklist 5.15: fields whose live value can't be parsed as a number
 * (ReviewWorkspace's isUnparseableAmount) -- same shape as EditedFieldSets,
 * covering only the amount-shaped fields buildSavePayload runs through
 * parseNum (header subtotal/taxAmount/totalAmount; line-item
 * quantity/rate/amount). Drives ERROR_RING_CLASS and blocks Save. */
export interface ValidationErrorSets {
  header: Set<keyof HeaderFormState>
  lineItems: Map<number, Set<string>>
}

const EMPTY_VALIDATION_ERRORS: ValidationErrorSets = { header: new Set(), lineItems: new Map() }

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

/** Plan §6 bottom clarification line: human-readable names for a flagged
 * header field, keyed by the same wire names as HEADER_WIRE_FIELD above. */
const HEADER_FIELD_LABEL: Record<string, string> = {
  vendor_name: 'Vendor name',
  vendor_gstin: 'GSTIN',
  vendor_phone: 'Phone',
  vendor_email: 'Email',
  vendor_address: 'Address',
  invoice_number: 'Invoice number',
  invoice_date: 'Invoice date',
  subtotal: 'Subtotal',
  tax_amount: 'Tax amount',
  total_amount: 'Total amount',
}

/** Same idea for a flagged line-item column, keyed by LINE_ITEM_WIRE_FIELD's
 * wire names -- combined with a row number (not lineOrder, which isn't
 * meaningful to a reviewer) in describeUncertainField below. */
const LINE_ITEM_FIELD_LABEL: Record<string, string> = {
  line_item_description: 'description',
  line_item_quantity: 'quantity',
  line_item_rate: 'rate',
  line_item_discount: 'discount',
  line_item_amount: 'amount',
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
    validationErrors = EMPTY_VALIDATION_ERRORS,
    invoiceDateWarning = null,
    onAddLineItem,
    addingLineItem = false,
    onReExtract,
    onFlagException,
    onJumpToPage,
    pageNumberStart = null,
    pageNumberEnd = null,
    currentPdfPage,
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
    /** Checklist 5.15: amount-shaped fields that couldn't be parsed as a
     *  number — drives the red ring (highest priority) and Save is blocked
     *  while this is non-empty. */
    validationErrors?: ValidationErrorSets
    /** Checklist 5.16: non-blocking advisory shown under Invoice Date when the
     *  live value is strictly after today -- null when there's nothing to warn
     *  about. */
    invoiceDateWarning?: string | null
    /** Checklist 5.21: "Add a row" in the empty-line-items state. Undefined
     *  hides the button entirely (defensive; ReviewWorkspace always passes it). */
    onAddLineItem?: () => void
    /** True while an addLineItem() call is in flight -- disables the button so
     *  a double-click can't insert two blank rows. */
    addingLineItem?: boolean
    /** Checklist 5.21: "Re-extract" in the empty-line-items state -- reuses
     *  ReviewWorkspace's existing requestReExtract, not a new code path. */
    onReExtract?: () => void
    /** Checklist 5.21: "Flag exception" in the empty-line-items state -- reuses
     *  ReviewWorkspace's existing setExceptionOpen(true), not a new code path. */
    onFlagException?: () => void
    /** Called with a field's source page when a flagged field is clicked/focused. */
    onJumpToPage?: (pageNumber: number) => void
    /** Checklist §6: the whole bill's page range (detail.pageNumberStart/End) --
     *  null for either means "unknown," same as the rest of the codebase treats
     *  a null page range. Used to label header fields with "pages a–b" when the
     *  bill spans more than one page and to caption the line-items table; a
     *  single-page bill gets neither, since "page 1" next to every field is
     *  noise, not information (plan §5/§6). */
    pageNumberStart?: number | null
    pageNumberEnd?: number | null
    /** Checklist §6: the PDF page currently on screen in PdfViewer, threaded
     *  down from ReviewWorkspace's existing pdfPageInfo state. Drives the
     *  quiet bottom clarification line ("This page has N flagged fields…"). */
    currentPdfPage: number
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

  /** A flagged field's position in `uncertainFields` -- rendered as
   *  `data-uncertain-index` so ReviewWorkspace's toolbar stepper can focus
   *  fields in order regardless of which section (header/vendor/line item)
   *  they live in. Reference equality is safe here since the matched object
   *  always comes from iterating this same array. */
  function uncertainIndexOf(uncertain: UncertainField | undefined): number | undefined {
    return uncertain ? uncertainFields.indexOf(uncertain) : undefined
  }

  function lineItemUncertainty(lineOrder: number, key: keyof Omit<LineItemFormState, 'id'>): UncertainField | undefined {
    const wireField = LINE_ITEM_WIRE_FIELD[key]
    if (!wireField) return undefined
    return uncertainByLineOrder.get(lineOrder)?.get(wireField)
  }

  // Plan §6: only worth labeling a header field with a page when that's
  // actually informative -- an individually-uncertain field gets its exact
  // page (real, precise data from uncertain_fields_ocr); everything else only
  // gets a label when the bill spans more than one page, since "page 1" next
  // to all ~11 header fields on a single-page bill is pure noise.
  function headerPageLabel(uncertain: UncertainField | undefined): string | undefined {
    if (uncertain) return `page ${uncertain.pageNumber}`
    if (pageNumberStart !== null && pageNumberEnd !== null && pageNumberStart !== pageNumberEnd) {
      return `pages ${pageNumberStart}–${pageNumberEnd}`
    }
    return undefined
  }

  // Plan §6 bottom clarification line: a human-readable name for one flagged
  // field, header or line item. Line items are named by row position (the
  // reviewer's own "row 3," not the internal lineOrder) since that's what's
  // visible on screen.
  function describeUncertainField(f: UncertainField): string {
    if (f.lineOrder === null) {
      return HEADER_FIELD_LABEL[f.field] ?? f.field.replace(/_/g, ' ')
    }
    const rowIndex = lineItems.findIndex((li) => li.lineOrder === f.lineOrder)
    const rowLabel = rowIndex >= 0 ? `Line ${rowIndex + 1}` : 'Line item'
    const fieldLabel = LINE_ITEM_FIELD_LABEL[f.field] ?? f.field.replace(/_/g, ' ')
    return `${rowLabel} ${fieldLabel}`
  }

  function headerEdited(key: keyof HeaderFormState): boolean {
    return editedFields.header.has(key)
  }

  function lineItemEdited(lineOrder: number, key: string): boolean {
    return editedFields.lineItems.get(lineOrder)?.has(key) ?? false
  }

  function headerError(key: keyof HeaderFormState): boolean {
    return validationErrors.header.has(key)
  }

  function lineItemError(lineOrder: number, key: string): boolean {
    return validationErrors.lineItems.get(lineOrder)?.has(key) ?? false
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

  const vendorNameUncertain = headerUncertainty('vendorName')
  const vendorNameUncertainIndex = uncertainIndexOf(vendorNameUncertain)
  const vendorNamePageLabel = headerPageLabel(vendorNameUncertain)

  // Plan §5/§6: whether the whole bill spans more than one page -- drives both
  // the line-items caption and the multi-page fallback in headerPageLabel.
  const isMultiPage = pageNumberStart !== null && pageNumberEnd !== null && pageNumberStart !== pageNumberEnd

  // Plan §6 bottom clarification line: which of this bill's flagged fields (if
  // any) live on the PDF page currently on screen.
  const currentPageUncertainFields = uncertainFields.filter((f) => f.pageNumber === currentPdfPage)

  return (
    <div ref={ref} className="flex h-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-1">
      <section className="grid grid-cols-2 gap-3 rounded-md border border-border p-3">
        <div className="col-span-2 flex flex-col gap-1.5">
          <Label>
            Vendor
            {vendorNamePageLabel ? (
              <span className="ml-1 text-xs font-normal text-muted-foreground">· {vendorNamePageLabel}</span>
            ) : null}
            {vendorNameUncertain ? (
              <span className="ml-1 text-orange-500" title="Model was uncertain about this value">●</span>
            ) : null}
          </Label>
          <VendorAutocomplete
            value={header.vendorName}
            selectedVendorId={vendorId}
            open={vendorAutocompleteOpen}
            onOpenChange={onVendorAutocompleteOpenChange}
            onSelect={onVendorSelect}
            fieldIndex={0}
            uncertain={!!vendorNameUncertain}
            uncertainIndex={vendorNameUncertainIndex}
            onFocus={() => vendorNameUncertain && onJumpToPage?.(vendorNameUncertain.pageNumber)}
          />
        </div>
        <Field label="GSTIN" disabled={disabled} onKeyDown={handleEnter}
          value={header.vendorGstin} onChange={(v) => onHeaderChange('vendorGstin', v)}
          uncertain={headerUncertainty('vendorGstin')} uncertainIndex={uncertainIndexOf(headerUncertainty('vendorGstin'))}
          edited={headerEdited('vendorGstin')} onJumpToPage={onJumpToPage} pageLabel={headerPageLabel(headerUncertainty('vendorGstin'))} />
        <Field label="Phone" disabled={disabled} onKeyDown={handleEnter}
          value={header.vendorPhone} onChange={(v) => onHeaderChange('vendorPhone', v)}
          uncertain={headerUncertainty('vendorPhone')} uncertainIndex={uncertainIndexOf(headerUncertainty('vendorPhone'))}
          edited={headerEdited('vendorPhone')} onJumpToPage={onJumpToPage} pageLabel={headerPageLabel(headerUncertainty('vendorPhone'))} />
        <Field label="Email" disabled={disabled} onKeyDown={handleEnter}
          value={header.vendorEmail} onChange={(v) => onHeaderChange('vendorEmail', v)}
          uncertain={headerUncertainty('vendorEmail')} uncertainIndex={uncertainIndexOf(headerUncertainty('vendorEmail'))}
          edited={headerEdited('vendorEmail')} onJumpToPage={onJumpToPage} pageLabel={headerPageLabel(headerUncertainty('vendorEmail'))} />
        <div className="col-span-2">
          <Field label="Address" disabled={disabled} onKeyDown={handleEnter}
            value={header.vendorAddress} onChange={(v) => onHeaderChange('vendorAddress', v)}
            uncertain={headerUncertainty('vendorAddress')} uncertainIndex={uncertainIndexOf(headerUncertainty('vendorAddress'))}
            edited={headerEdited('vendorAddress')} onJumpToPage={onJumpToPage} pageLabel={headerPageLabel(headerUncertainty('vendorAddress'))} />
        </div>
        <Field label="Invoice number" disabled={disabled} onKeyDown={handleEnter}
          value={header.invoiceNumber} onChange={(v) => onHeaderChange('invoiceNumber', v)}
          uncertain={headerUncertainty('invoiceNumber')} uncertainIndex={uncertainIndexOf(headerUncertainty('invoiceNumber'))}
          edited={headerEdited('invoiceNumber')} onJumpToPage={onJumpToPage} pageLabel={headerPageLabel(headerUncertainty('invoiceNumber'))} />
        <Field label="Invoice date" type="date" disabled={disabled} onKeyDown={handleEnter}
          value={header.invoiceDate} onChange={(v) => onHeaderChange('invoiceDate', v)}
          uncertain={headerUncertainty('invoiceDate')} uncertainIndex={uncertainIndexOf(headerUncertainty('invoiceDate'))}
          edited={headerEdited('invoiceDate')} onJumpToPage={onJumpToPage} warning={invoiceDateWarning} pageLabel={headerPageLabel(headerUncertainty('invoiceDate'))} />
        <Field label="Subtotal" inputMode="decimal" disabled={disabled} onKeyDown={handleEnter}
          value={header.subtotal} onChange={(v) => onHeaderChange('subtotal', v)}
          uncertain={headerUncertainty('subtotal')} uncertainIndex={uncertainIndexOf(headerUncertainty('subtotal'))}
          edited={headerEdited('subtotal')} error={headerError('subtotal')} onJumpToPage={onJumpToPage} pageLabel={headerPageLabel(headerUncertainty('subtotal'))} />
        <Field label="Tax amount" inputMode="decimal" disabled={disabled} onKeyDown={handleEnter}
          value={header.taxAmount} onChange={(v) => onHeaderChange('taxAmount', v)}
          uncertain={headerUncertainty('taxAmount')} uncertainIndex={uncertainIndexOf(headerUncertainty('taxAmount'))}
          edited={headerEdited('taxAmount')} error={headerError('taxAmount')} onJumpToPage={onJumpToPage} pageLabel={headerPageLabel(headerUncertainty('taxAmount'))} />
        <Field label="Total amount" inputMode="decimal" disabled={disabled} onKeyDown={handleEnter}
          value={header.totalAmount} onChange={(v) => onHeaderChange('totalAmount', v)}
          uncertain={headerUncertainty('totalAmount')} uncertainIndex={uncertainIndexOf(headerUncertainty('totalAmount'))}
          edited={headerEdited('totalAmount')} error={headerError('totalAmount')} onJumpToPage={onJumpToPage} pageLabel={headerPageLabel(headerUncertainty('totalAmount'))} />
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
        {isMultiPage ? (
          // Plan §6: no per-row/per-cell page data exists beyond individually
          // uncertain cells (checked -- see task scoping), so this is one
          // caption for the whole table rather than repeating a label on every
          // one of 6 columns x N rows. Omitted entirely on a single-page bill,
          // same reasoning as headerPageLabel above.
          <p className="-mt-1 text-xs text-muted-foreground">
            Read from pages {pageNumberStart}–{pageNumberEnd}.
          </p>
        ) : null}
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
                const descUncertainIndex = uncertainIndexOf(descUncertain)
                const qtyUncertainIndex = uncertainIndexOf(qtyUncertain)
                const rateUncertainIndex = uncertainIndexOf(rateUncertain)
                const discountUncertainIndex = uncertainIndexOf(discountUncertain)
                const amountUncertainIndex = uncertainIndexOf(amountUncertain)
                const qtyError = lineItemError(item.lineOrder, 'quantity')
                const rateError = lineItemError(item.lineOrder, 'rate')
                const amountError = lineItemError(item.lineOrder, 'amount')
                // 5.15: error outranks uncertain outranks edited -- a field
                // that's both model-uncertain and unparseable still shows
                // red, since it will silently fail to save either way.
                const ringClass = (uncertain: UncertainField | undefined, editedKey: string, error = false) =>
                  error
                    ? ERROR_RING_CLASS
                    : uncertain
                      ? UNCERTAIN_RING_CLASS
                      : lineItemEdited(item.lineOrder, editedKey)
                        ? EDITED_RING_CLASS
                        : ''
                const titleFor = (uncertain: UncertainField | undefined, editedKey: string, error = false) =>
                  error
                    ? 'This value could not be read as a number and will not be saved -- fix or clear it'
                    : uncertain
                      ? `Model was uncertain about this value — click to jump to page ${uncertain.pageNumber}`
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
                          data-uncertain-index={descUncertainIndex}
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
                          data-uncertain-index={qtyUncertainIndex}
                          data-validation-error={qtyError ? 'true' : undefined}
                          className={ringClass(qtyUncertain, 'quantity', qtyError)}
                          title={titleFor(qtyUncertain, 'quantity', qtyError)}
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
                          data-uncertain-index={rateUncertainIndex}
                          data-validation-error={rateError ? 'true' : undefined}
                          className={ringClass(rateUncertain, 'rate', rateError)}
                          title={titleFor(rateUncertain, 'rate', rateError)}
                          onFocus={() => rateUncertain && onJumpToPage?.(rateUncertain.pageNumber)}
                          value={item.rate}
                          onChange={(e) => onLineItemChange(item.id, 'rate', e.target.value)} onKeyDown={handleEnter} />
                      </td>
                      <td className="min-w-24 px-1 py-1">
                        <Input inputMode="decimal" disabled={disabled}
                          data-uncertain-index={amountUncertainIndex}
                          data-validation-error={amountError ? 'true' : undefined}
                          className={ringClass(amountUncertain, 'amount', amountError)}
                          title={titleFor(amountUncertain, 'amount', amountError)}
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
                              <Input disabled={disabled} data-uncertain-index={discountUncertainIndex}
                                className={`w-28 ${ringClass(discountUncertain, 'discount')}`}
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
                // 5.21: an empty extraction was previously a dead end -- just
                // a sentence with no next step. All three actions here reuse
                // existing ReviewWorkspace machinery (requestReExtract,
                // setExceptionOpen); only "Add a row" is new (addLineItem,
                // lib/actions/review.ts).
                <tr>
                  <td colSpan={6} className="px-2 py-4 text-center text-sm text-muted-foreground">
                    <p>No line items were extracted from this document.</p>
                    <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                      <Button type="button" size="sm" variant="outline" disabled={disabled || addingLineItem} onClick={onAddLineItem}>
                        {addingLineItem ? 'Adding…' : 'Add a row'}
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={onReExtract}>
                        Re-extract
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={onFlagException}>
                        Flag exception
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {/* Plan §5/§6: the quiet clarification line, at the very bottom of the
          panel (never a banner blocking the top -- see this file's L2
          comment and the plan's §5 correction). Nothing renders when this
          bill has no uncertain fields at all -- there's nothing to clarify. */}
      {uncertainFields.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {currentPageUncertainFields.length > 0
            ? `This page has ${currentPageUncertainFields.length} flagged field${currentPageUncertainFields.length === 1 ? '' : 's'}: ${currentPageUncertainFields.map(describeUncertainField).join(', ')}.`
            : 'No flagged fields on this page.'}
        </p>
      ) : null}
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
  uncertainIndex,
  edited = false,
  error = false,
  warning = null,
  onJumpToPage,
  pageLabel,
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
  /** This field's position in the `uncertainFields` array -- rendered as
   *  `data-uncertain-index` for the toolbar's next/previous stepper. */
  uncertainIndex?: number
  /** True when the live value differs from its OCR baseline. */
  edited?: boolean
  /** Checklist 5.15: true when this value can't be parsed as a number --
   *  outranks both `uncertain` and `edited` for ring colour/title, and marks
   *  `data-validation-error` so ReviewWorkspace's handleSave can focus it. */
  error?: boolean
  /** Checklist 5.16: non-blocking advisory rendered under the field (e.g.
   *  "This invoice date is in the future.") -- null renders nothing. Distinct
   *  from `error`: this never blocks Save or affects the ring colour. */
  warning?: string | null
  onJumpToPage?: (pageNumber: number) => void
  /** Plan §6: "page N" for a field individually flagged uncertain, or
   *  "pages a–b" for the whole bill when it spans more than one page --
   *  undefined renders nothing (single-page bill, field not uncertain).
   *  Computed by the caller (headerPageLabel) since it needs the bill's
   *  pageNumberStart/End, which this presentational component doesn't have. */
  pageLabel?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>
        {label}
        {pageLabel ? <span className="ml-1 text-xs font-normal text-muted-foreground">· {pageLabel}</span> : null}
        {error ? (
          <span className="ml-1 text-red-500" title="This value could not be read as a number and will not be saved">●</span>
        ) : uncertain ? (
          <span className="ml-1 text-orange-500" title="Model was uncertain about this value">●</span>
        ) : edited ? (
          <span className="ml-1 text-blue-500" title="Edited from the original OCR value">●</span>
        ) : null}
      </Label>
      <Input
        type={type}
        inputMode={inputMode}
        disabled={disabled}
        data-uncertain-index={uncertainIndex}
        data-validation-error={error ? 'true' : undefined}
        className={error ? ERROR_RING_CLASS : uncertain ? UNCERTAIN_RING_CLASS : edited ? EDITED_RING_CLASS : ''}
        title={
          error
            ? 'This value could not be read as a number and will not be saved — fix or clear it'
            : uncertain
              ? `Model was uncertain about this value — click to jump to page ${uncertain.pageNumber}`
              : edited
                ? 'Edited from the original OCR value'
                : undefined
        }
        onFocus={() => uncertain && onJumpToPage?.(uncertain.pageNumber)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {warning ? <p className="text-xs text-amber-600 dark:text-amber-400">{warning}</p> : null}
    </div>
  )
}
