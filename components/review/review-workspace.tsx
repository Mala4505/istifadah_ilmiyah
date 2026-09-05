'use client'

/**
 * The review screen's throughput engine (MASTER-PLAN §7, §11.2 Day 4). Owns
 * all form state and the full keyboard contract; every subcomponent here is
 * presentational or a thin dialog wrapper around a server action.
 *
 * Persistence model: `Enter` never hits the network -- it only advances
 * focus. Everything typed (or left as the OCR value) already lives in this
 * component's state, which is exactly what "untouched = accepted on save"
 * needs: an untouched field's state never diverged from its OCR value, so
 * sending it to the RPC unchanged writes `_verified = _ocr` for that field --
 * agreement, not a correction, with zero extra bookkeeping. `Cmd/Ctrl-Enter`
 * is the one network call: it saves the whole document via the atomic RPC
 * (lib/actions/review.ts's saveVerification) and advances to the next queue
 * document.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type PointerEvent as ReactPointerEvent } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { exceptionTypeLabel, severityBadgeVariant } from '@/components/exceptions/labels'
import { formatDateTime } from '@/lib/reports/format'
import { normalizeUnit, normalizeVendorName } from '@/lib/normalize'
import {
  addLineItem,
  claimReviewDocument,
  confirmVendorAlias,
  reExtractField,
  releaseReviewDocument,
  saveEntryClassification,
  saveVerification,
  type ReExtractableHeaderField,
  type SaveVerificationInput,
  type VendorSearchResult,
} from '@/lib/actions/review'
import { type ReviewDocumentDetail } from '@/lib/review/types'
import { type Keymap, formatBinding, isSafeShortcutTarget, matchLineDigit, matchesBinding } from '@/lib/shortcuts/config'
import type { PdfViewerHandle } from './pdf-viewer'
import {
  ExtractionForm,
  type EditedFieldSets,
  type HeaderFormState,
  type LineItemFormState,
  type ValidationErrorSets,
} from './extraction-form'
import { TallyFooter } from './tally-footer'
import { ClaimBanner } from './claim-banner'
import { ShortcutsOverlay } from './shortcuts-overlay'
import { ExceptionDialog } from './exception-dialog'
import { HubStatusDialog } from './hub-status-dialog'
import { ReviewStatusLine, type StageStatus } from './review-status-line'

// Perf audit 3.1: pdf-viewer.tsx wraps pdf.js (worker/wasm assets) -- eagerly
// bundling it into /review's first paint costs bytes no reviewer needs until
// a bill is actually open. `ssr: false` because pdf.js reaches for browser
// APIs (Worker, canvas) that don't exist server-side; PdfViewerHandle stays a
// type-only import above (zero runtime cost) since only the value needs
// deferring. The loading placeholder matches the left pane's own dimensions
// (see the wrapping div's `width` a few hundred lines down) so swapping in
// the real PdfViewer doesn't jank the layout, and reuses pdf-viewer.tsx's own
// internal loading Skeleton (same aspect ratio it uses while pdf.js loads).
const PdfViewer = dynamic(() => import('./pdf-viewer').then((mod) => mod.PdfViewer), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-md border border-border bg-muted/30 p-3">
      <Skeleton className="mx-auto h-full max-h-[80vh] w-full max-w-md" style={{ aspectRatio: '1 / 1.414' }} />
    </div>
  ),
})

const NONE = '__none__'

// L1 (checklist 3.4-3.6): the PDF/form split is a working style, not a
// per-document decision -- a reviewer who works Collapsed stays Collapsed
// across the whole queue, so both the named mode and the dragged ratio
// persist in localStorage rather than component state.
const PANE_MODE_KEY = 'review-pdf-pane-mode'
const PANE_SPLIT_KEY = 'review-pdf-pane-split'
const SPLIT_PERCENT_BOUNDS = { min: 15, max: 85 }
const PANE_MODE_DEFAULT_SPLIT: Record<'split' | 'document', number> = { split: 50, document: 75 }
const COLLAPSED_PANE_WIDTH_PX = 120

type PdfPaneMode = 'split' | 'collapsed' | 'document'

function readStoredPaneMode(): PdfPaneMode {
  if (typeof window === 'undefined') return 'split'
  const stored = window.localStorage.getItem(PANE_MODE_KEY)
  return stored === 'split' || stored === 'collapsed' || stored === 'document' ? stored : 'split'
}

function readStoredSplitPercent(): number {
  if (typeof window === 'undefined') return PANE_MODE_DEFAULT_SPLIT.split
  const stored = Number(window.localStorage.getItem(PANE_SPLIT_KEY))
  return Number.isFinite(stored) && stored >= SPLIT_PERCENT_BOUNDS.min && stored <= SPLIT_PERCENT_BOUNDS.max
    ? stored
    : PANE_MODE_DEFAULT_SPLIT.split
}

function numToStr(v: string | number | null): string {
  return v === null || v === undefined ? '' : String(v)
}

// 5.14 (checklist Phase 5, plan §13): accepts the two shapes real invoices
// print amounts in that `Number(...)` chokes on -- a leading rupee sign and
// thousands-separator commas. Stripped before parsing, not after -- there is
// no other reason a decimal amount would contain either character. A
// genuinely blank field still returns null with no warning (isUnparseableAmount
// below is what tells "blank" apart from "garbage").
function parseNum(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  const cleaned = t.replace(/^₹\s*/, '').replace(/,/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

// 5.15: `parseNum(s) === null` is ambiguous by itself -- "" (intentionally
// blank) and "abc" (garbage) both collapse to null, and today that garbage
// silently saves as a null amount with no warning. This tells them apart so
// buildSavePayload/validationErrors can block only the second case.
function isUnparseableAmount(raw: string): boolean {
  const t = raw.trim()
  if (!t) return false
  return parseNum(t) === null
}

// 5.16: local calendar date (not UTC) so "today" matches whatever the
// reviewer's own clock shows in the date picker -- YYYY-MM-DD sorts
// lexicographically the same as chronologically, so a plain string compare
// against header.invoiceDate is enough, no Date-object arithmetic needed.
function todayLocalDateString(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Phase 4 (§2.6): maps an uncertain field's wire name (detail.uncertainFields'
// `field`, matching UNCERTAIN_FIELD_NAMES in lib/extraction-schema.ts) to (a)
// which HeaderFormState key reExtractField's result should patch and (b) the
// literal ReExtractableHeaderField value the action itself expects -- these
// happen to be spelled identically (both are the same snake_case wire name),
// so one lookup covers both call sites below. Deliberately only the 10 header
// names reExtractField accepts (lib/actions/review.ts's doc comment on
// ReExtractableHeaderField) -- the five line_item_* wire names have no entry
// here, which is what keeps the affordance from ever being offered on a line
// item (headerFieldForUncertain returns undefined for those).
const UNCERTAIN_FIELD_TO_HEADER_KEY: Partial<Record<string, keyof HeaderFormState>> = {
  vendor_name: 'vendorName',
  vendor_gstin: 'vendorGstin',
  vendor_phone: 'vendorPhone',
  vendor_email: 'vendorEmail',
  vendor_address: 'vendorAddress',
  invoice_number: 'invoiceNumber',
  invoice_date: 'invoiceDate',
  subtotal: 'subtotal',
  tax_amount: 'taxAmount',
  total_amount: 'totalAmount',
}

// Human-readable labels for the same wire names, for the re-extract strip's
// button text/toasts -- a local copy rather than importing extraction-form's
// own (unexported) HEADER_FIELD_LABEL, since that file is out of scope for
// this change.
const UNCERTAIN_FIELD_LABEL: Record<string, string> = {
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

/** Whether an uncertain-field wire name is one of the 10 header fields
 *  reExtractField accepts, narrowing the string to ReExtractableHeaderField
 *  when true. line_item_* names (and anything else unrecognised) return
 *  false -- v1 deliberately offers no re-extract affordance for those (see
 *  ReExtractableHeaderField's doc comment, lib/actions/review.ts). */
function isReExtractableHeaderField(field: string): field is ReExtractableHeaderField {
  return field in UNCERTAIN_FIELD_TO_HEADER_KEY
}

function buildHeaderState(detail: ReviewDocumentDetail): HeaderFormState {
  const h = detail.header
  return {
    vendorName: numToStr(h.vendorName.verified ?? h.vendorName.ocr),
    vendorGstin: numToStr(h.vendorGstin.verified ?? h.vendorGstin.ocr),
    vendorPhone: numToStr(h.vendorPhone.verified ?? h.vendorPhone.ocr),
    vendorEmail: numToStr(h.vendorEmail.verified ?? h.vendorEmail.ocr),
    vendorAddress: numToStr(h.vendorAddress.verified ?? h.vendorAddress.ocr),
    buyerGstin: numToStr(h.buyerGstin.verified ?? h.buyerGstin.ocr),
    buyerName: numToStr(h.buyerName.verified ?? h.buyerName.ocr),
    invoiceNumber: numToStr(h.invoiceNumber.verified ?? h.invoiceNumber.ocr),
    invoiceDate: numToStr(h.invoiceDate.verified ?? h.invoiceDate.ocr),
    subtotal: numToStr(h.subtotal.verified ?? h.subtotal.ocr),
    taxAmount: numToStr(h.taxAmount.verified ?? h.taxAmount.ocr),
    totalAmount: numToStr(h.totalAmount.verified ?? h.totalAmount.ocr),
    notes: numToStr(h.notes.verified ?? h.notes.ocr),
  }
}

function buildLineItemState(detail: ReviewDocumentDetail): LineItemFormState[] {
  return detail.lineItems.map((li) => ({
    id: li.id,
    lineOrder: li.lineOrder,
    description: numToStr(li.description.verified ?? li.description.ocr),
    hsnSacCode: numToStr(li.hsnSacCode.verified ?? li.hsnSacCode.ocr),
    quantity: numToStr(li.quantity.verified ?? li.quantity.ocr),
    quantityRawText: numToStr(li.quantityRawText.verified ?? li.quantityRawText.ocr),
    unit: numToStr(li.unit.verified ?? li.unit.ocr),
    unitNormalized: li.unitNormalized ?? '',
    rate: numToStr(li.rate.verified ?? li.rate.ocr),
    discount: numToStr(li.discount.verified ?? li.discount.ocr),
    amount: numToStr(li.amount.verified ?? li.amount.ocr),
  }))
}

export function ReviewWorkspace({
  detail,
  queue,
  currentIndex,
  prevId,
  nextId,
  keymap,
  shortcutsEnabled,
  initialPageOverride,
}: {
  detail: ReviewDocumentDetail
  // Widened for the Document nav (redesign point 4): QueueEntry
  // (lib/review/types.ts) already carries sourceDocumentId per row -- this
  // prop just needed to stop narrowing it away so distinct source PDFs can
  // be walked here without a second query.
  queue: { documentExtractionId: number; sourceDocumentId: number }[]
  currentIndex: number
  prevId: number | null
  nextId: number | null
  keymap: Keymap
  shortcutsEnabled: boolean
  // review/page.tsx's `&page=N` override -- set when this document was
  // reached by clicking a sibling bill's page in the PDF thumbnail rail
  // (handleRequestBillSwitch below), so PdfViewer opens on that exact page
  // instead of this bill's own first page.
  initialPageOverride: number | null
}) {
  const router = useRouter()
  const formContainerRef = useRef<HTMLDivElement>(null)
  const pdfViewerRef = useRef<PdfViewerHandle>(null)

  // Hub cert 2.4 (moved up from its old spot near the bottom of this
  // component so the 5.7 bill-switch reset block below can reach it --
  // useRef(false) has no dependency on anything declared later, so this move
  // is behaviour-neutral). See the initial-focus effect near the return
  // statement for what actually reads/sets this.
  const didInitialFocusRef = useRef(false)

  // 5.4: one-way dirty latch (declared here, ahead of the state slices below,
  // so onHeaderChange/onLineItemChange can close over it without a temporal-
  // dead-zone concern). Flipped true the first time any header field or line
  // item actually changes; replaces a JSON.stringify comparison that used to
  // run over the whole header plus every line item, twice, on every
  // keystroke. Never needs to go back to false before this component's next
  // full remount (a genuinely different document or a fresh extraction run).
  const hasEditedRef = useRef(false)

  // 5.1 (perf remediation, Phase 5): twelve independent state slices instead
  // of one HeaderFormState object -- typing into one field used to replace
  // the whole object's identity every keystroke, which is what forced every
  // memo below that keyed on `header` (editedFields, validationErrors,
  // dirty) to recompute regardless of which field actually changed.
  // `header` itself is still assembled just below (useMemo) purely so
  // ExtractionForm/buildSavePayload -- which genuinely need the full set --
  // don't have to change shape, but nothing here uses that assembled object
  // as a hook dependency; each memo now depends on only the field(s) it
  // actually reads.
  const initialHeaderRef = useRef<HeaderFormState | null>(null)
  if (initialHeaderRef.current === null) initialHeaderRef.current = buildHeaderState(detail)
  const initialHeader = initialHeaderRef.current

  const [vendorName, setVendorName] = useState(initialHeader.vendorName)
  const [vendorGstin, setVendorGstin] = useState(initialHeader.vendorGstin)
  const [vendorPhone, setVendorPhone] = useState(initialHeader.vendorPhone)
  const [vendorEmail, setVendorEmail] = useState(initialHeader.vendorEmail)
  const [vendorAddress, setVendorAddress] = useState(initialHeader.vendorAddress)
  const [buyerGstin, setBuyerGstin] = useState(initialHeader.buyerGstin)
  const [buyerName, setBuyerName] = useState(initialHeader.buyerName)
  const [invoiceNumber, setInvoiceNumber] = useState(initialHeader.invoiceNumber)
  const [invoiceDate, setInvoiceDate] = useState(initialHeader.invoiceDate)
  const [subtotal, setSubtotal] = useState(initialHeader.subtotal)
  const [taxAmount, setTaxAmount] = useState(initialHeader.taxAmount)
  const [totalAmount, setTotalAmount] = useState(initialHeader.totalAmount)
  const [notes, setNotes] = useState(initialHeader.notes)

  // Assembled once per render from the slices above -- a plain useMemo, not
  // another useState, so there is exactly one source of truth per field
  // (the slice) and this can never drift from it. Still gets a new identity
  // on every keystroke (unavoidable: SOME field's value just changed and
  // ExtractionForm needs to see it) -- that's fine, since nothing here reads
  // `header` itself as a memo dependency any more (see editedFields/
  // validationErrors/invoiceDateWarning below).
  const header: HeaderFormState = useMemo(
    () => ({
      vendorName,
      vendorGstin,
      vendorPhone,
      vendorEmail,
      vendorAddress,
      buyerGstin,
      buyerName,
      invoiceNumber,
      invoiceDate,
      subtotal,
      taxAmount,
      totalAmount,
      notes,
    }),
    [
      vendorName,
      vendorGstin,
      vendorPhone,
      vendorEmail,
      vendorAddress,
      buyerGstin,
      buyerName,
      invoiceNumber,
      invoiceDate,
      subtotal,
      taxAmount,
      totalAmount,
      notes,
    ]
  )

  // 5.2: the single callback ExtractionForm calls on every keystroke. Field
  // setters from useState are referentially stable for the lifetime of this
  // component (React guarantees it), so this can be a `[]`-deps useCallback
  // -- one stable function identity for the whole mount, letting memo(
  // ExtractionForm) actually compare it as unchanged.
  const onHeaderChange = useCallback((field: keyof HeaderFormState, value: string) => {
    hasEditedRef.current = true
    switch (field) {
      case 'vendorName':
        setVendorName(value)
        break
      case 'vendorGstin':
        setVendorGstin(value)
        break
      case 'vendorPhone':
        setVendorPhone(value)
        break
      case 'vendorEmail':
        setVendorEmail(value)
        break
      case 'vendorAddress':
        setVendorAddress(value)
        break
      case 'buyerGstin':
        setBuyerGstin(value)
        break
      case 'buyerName':
        setBuyerName(value)
        break
      case 'invoiceNumber':
        setInvoiceNumber(value)
        break
      case 'invoiceDate':
        setInvoiceDate(value)
        break
      case 'subtotal':
        setSubtotal(value)
        break
      case 'taxAmount':
        setTaxAmount(value)
        break
      case 'totalAmount':
        setTotalAmount(value)
        break
      case 'notes':
        setNotes(value)
        break
    }
  }, [])

  const [lineItems, setLineItems] = useState<LineItemFormState[]>(() => buildLineItemState(detail))
  const [vendorId, setVendorId] = useState<number | null>(detail.entryVendorId)
  const [vendorAutocompleteOpen, setVendorAutocompleteOpen] = useState(false)

  // 5.2: same stability requirement as onHeaderChange above -- ExtractionForm
  // (and its per-row inputs) are memoized, so this needs one identity for
  // the whole mount rather than a fresh closure every render.
  const onLineItemChange = useCallback(
    (id: number, field: keyof Omit<LineItemFormState, 'id'>, value: string) => {
      hasEditedRef.current = true
      setLineItems((items) => items.map((li) => (li.id === id ? { ...li, [field]: value } : li)))
    },
    []
  )

  // Redesign plan §2: PdfViewer owns pageNumber/numPages internally and only
  // exposed an imperative nextPage/prevPage/goToPage handle before this --
  // the nav cluster's Page group needs the current position too, so PdfViewer
  // reports it back here on every change via onPageInfoChange.
  const [pdfPageInfo, setPdfPageInfo] = useState({ pageNumber: 1, numPages: 0 })
  // Stable identity required: PdfViewer's reporting effect depends on this
  // callback, so an inline arrow here (a fresh reference every render) would
  // re-fire that effect on every render of *this* component too -- since the
  // effect's own job is calling setPdfPageInfo, that's an infinite loop.
  const handlePdfPageInfoChange = useCallback((pageNumber: number, numPages: number) => {
    setPdfPageInfo({ pageNumber, numPages })
  }, [])

  // Checklist 4.2: the toolbar's "N of M to check" stepper. Fields carry a
  // stable `data-uncertain-index` (their position in detail.uncertainFields,
  // set in ExtractionForm/VendorAutocomplete) that this focuses directly --
  // the field's own onFocus handler (already wired for the orange-ring
  // affordance) takes care of the PDF jump, so this only needs to focus.
  const [uncertainStepIndex, setUncertainStepIndex] = useState<number | null>(null)
  function focusUncertainField(index: number) {
    formContainerRef.current?.querySelector<HTMLElement>(`[data-uncertain-index="${index}"]`)?.focus()
  }
  function stepUncertainField(direction: 1 | -1) {
    const total = detail.uncertainFields.length
    if (total === 0) return
    const next =
      uncertainStepIndex === null
        ? direction === 1
          ? 0
          : total - 1
        : (uncertainStepIndex + direction + total) % total
    setUncertainStepIndex(next)
    focusUncertainField(next)
  }

  // Dirty tracking (D3/plan §2, checklist 1.5): 5.4 replaced the old
  // JSON.stringify-against-initial-snapshot comparison with the one-way
  // hasEditedRef latch declared above -- see its own comment for why a ref
  // is enough (every place that flips it also calls a setState in the same
  // handler, so the next render always observes it correctly).
  const dirty = hasEditedRef.current

  // 5.7: review/page.tsx now keys ReviewWorkspace on sourceDocumentId (not
  // documentExtractionId), so PdfViewer survives stepping between sibling
  // bills of the same PDF instead of unmounting/refetching/reparsing on
  // every J/K press -- but that also means THIS component no longer
  // remounts on a bill switch. Everything above that used to reset itself
  // for free via a fresh mount (header/line-item state, the dirty latch, the
  // uncertain-field stepper, vendorId, initial focus) has to reset itself
  // explicitly here instead. This is the "adjust state when a prop changes"
  // pattern (react.dev) -- calling setState conditionally during render --
  // rather than an effect, specifically to avoid a one-frame flash of the
  // previous bill's data between the prop update and an effect running
  // after paint. The claim effects further below stay keyed on
  // sourceDocumentId on purpose; that's what stops them firing on this same
  // bill switch.
  //
  // Keyed on documentExtractionId OR currentExtractionRunId, not just the
  // former: a bill switch changes documentExtractionId, but a whole-document
  // re-extract (handleReExtract below, via router.refresh()) keeps the same
  // documentExtractionId (extract.ts upserts onto the existing row) and only
  // bumps currentExtractionRunId. Before 5.7, that refresh's fresh detail
  // still remounted this component because currentExtractionRunId was part
  // of the React key page.tsx passed down -- now that the key is
  // sourceDocumentId-only, this reset has to watch both fields itself or a
  // full re-extract would silently leave stale header/line-item state on
  // screen. (handleReExtractField, the single-field re-extract, deliberately
  // never calls router.refresh() -- see its own comment -- so it never
  // reaches this branch.)
  const [resetKey, setResetKey] = useState({
    documentExtractionId: detail.documentExtractionId,
    currentExtractionRunId: detail.currentExtractionRunId,
  })
  if (
    detail.documentExtractionId !== resetKey.documentExtractionId ||
    detail.currentExtractionRunId !== resetKey.currentExtractionRunId
  ) {
    setResetKey({
      documentExtractionId: detail.documentExtractionId,
      currentExtractionRunId: detail.currentExtractionRunId,
    })
    const freshHeader = buildHeaderState(detail)
    setVendorName(freshHeader.vendorName)
    setVendorGstin(freshHeader.vendorGstin)
    setVendorPhone(freshHeader.vendorPhone)
    setVendorEmail(freshHeader.vendorEmail)
    setVendorAddress(freshHeader.vendorAddress)
    setBuyerGstin(freshHeader.buyerGstin)
    setBuyerName(freshHeader.buyerName)
    setInvoiceNumber(freshHeader.invoiceNumber)
    setInvoiceDate(freshHeader.invoiceDate)
    setSubtotal(freshHeader.subtotal)
    setTaxAmount(freshHeader.taxAmount)
    setTotalAmount(freshHeader.totalAmount)
    setNotes(freshHeader.notes)
    setLineItems(buildLineItemState(detail))
    setVendorId(detail.entryVendorId)
    setUncertainStepIndex(null)
    hasEditedRef.current = false
    didInitialFocusRef.current = false
  }

  // L3 (plan §11, checklist 3.3): "edited from OCR" is a different question
  // from `dirty` above -- dirty compares against this mount's initial
  // snapshot (which may already include a previous reviewer's corrections);
  // this compares the live value against `detail.header`/`detail.lineItems`'
  // `.ocr` baseline, so a field corrected in an earlier pass and left
  // untouched now still reads as edited. Feeds ExtractionForm's blue ring
  // and drives L2's per-row auto-expand.
  // 5.3: baseline line items keyed by id, replacing the O(n²)
  // `detail.lineItems.find(d => d.id === li.id)` that used to run inside the
  // loop below. Only depends on detail.lineItems (server data, fixed for
  // this mount/bill), never on live `lineItems`, so it's built once per bill
  // rather than rebuilt every keystroke.
  const baselineLineItemById = useMemo(
    () => new Map(detail.lineItems.map((d) => [d.id, d] as const)),
    [detail.lineItems]
  )

  // 5.3: split in two so a keystroke in a header field only recomputes the
  // (cheap, 12-key) header half, and editing a line item only recomputes the
  // (O(n), baseline-map-backed) line-items half -- the original combined
  // memo depended on `[header, lineItems, detail]` together, so ANY keystroke
  // anywhere re-ran both loops.
  const editedHeaderFields = useMemo<Set<keyof HeaderFormState>>(() => {
    const headerSet = new Set<keyof HeaderFormState>()
    for (const key of Object.keys(header) as (keyof HeaderFormState)[]) {
      if (header[key].trim() !== numToStr(detail.header[key].ocr).trim()) headerSet.add(key)
    }
    return headerSet
  }, [header, detail.header])

  const editedLineItemFields = useMemo<Map<number, Set<string>>>(() => {
    const lineItemsMap = new Map<number, Set<string>>()
    for (const li of lineItems) {
      const baseline = baselineLineItemById.get(li.id)
      if (!baseline) continue
      const editedKeys = new Set<string>()
      const checks: [string, string, string | number | null][] = [
        ['description', li.description, baseline.description.ocr],
        ['hsnSacCode', li.hsnSacCode, baseline.hsnSacCode.ocr],
        ['quantity', li.quantity, baseline.quantity.ocr],
        ['quantityRawText', li.quantityRawText, baseline.quantityRawText.ocr],
        // The Unit column edits/displays `unitNormalized`, not `unit` --
        // compare what's shown against the same OCR baseline it started from.
        ['unitNormalized', li.unitNormalized || li.unit, baseline.unit.ocr],
        ['rate', li.rate, baseline.rate.ocr],
        ['discount', li.discount, baseline.discount.ocr],
        ['amount', li.amount, baseline.amount.ocr],
      ]
      for (const [key, liveValue, ocrValue] of checks) {
        if (liveValue.trim() !== numToStr(ocrValue).trim()) editedKeys.add(key)
      }
      if (editedKeys.size > 0) lineItemsMap.set(li.lineOrder, editedKeys)
    }
    return lineItemsMap
  }, [lineItems, baselineLineItemById])

  const editedFields = useMemo<EditedFieldSets>(
    () => ({ header: editedHeaderFields, lineItems: editedLineItemFields }),
    [editedHeaderFields, editedLineItemFields]
  )

  // 5.15 (checklist Phase 5, plan §13): every amount-shaped field that
  // buildSavePayload below runs through parseNum, checked with
  // isUnparseableAmount so a genuinely blank field (parses to null, no error)
  // and garbage text (also parses to null, but should block save) are told
  // apart. Shaped exactly like editedFields above -- header Set + line-items
  // Map keyed by lineOrder -- so ExtractionForm can reuse the same lookup
  // pattern for the red ring.
  //
  // 5.1/5.3: split the same way as editedFields above -- the header half
  // depends only on the three amount fields it actually checks, not the
  // whole assembled `header` object, so typing in e.g. vendorName or notes
  // no longer triggers this at all.
  const validationHeaderErrors = useMemo<Set<keyof HeaderFormState>>(() => {
    const headerSet = new Set<keyof HeaderFormState>()
    if (isUnparseableAmount(subtotal)) headerSet.add('subtotal')
    if (isUnparseableAmount(taxAmount)) headerSet.add('taxAmount')
    if (isUnparseableAmount(totalAmount)) headerSet.add('totalAmount')
    return headerSet
  }, [subtotal, taxAmount, totalAmount])

  const validationLineItemErrors = useMemo<Map<number, Set<string>>>(() => {
    const lineItemsMap = new Map<number, Set<string>>()
    for (const li of lineItems) {
      const errorKeys = new Set<string>()
      if (isUnparseableAmount(li.quantity)) errorKeys.add('quantity')
      if (isUnparseableAmount(li.rate)) errorKeys.add('rate')
      if (isUnparseableAmount(li.amount)) errorKeys.add('amount')
      if (errorKeys.size > 0) lineItemsMap.set(li.lineOrder, errorKeys)
    }
    return lineItemsMap
  }, [lineItems])

  const validationErrors = useMemo<ValidationErrorSets>(
    () => ({ header: validationHeaderErrors, lineItems: validationLineItemErrors }),
    [validationHeaderErrors, validationLineItemErrors]
  )

  // Phase 4 (§2.6): the subset of detail.uncertainFields that (a) are header
  // fields (lineOrder === null -- a line item's uncertain entry has a
  // lineOrder) and (b) are in reExtractField's v1 subset (the 10 header wire
  // names, not the 5 line_item_* ones). Drives the re-extract strip below.
  const reExtractableUncertainFields = useMemo(
    () => detail.uncertainFields.filter((f) => f.lineOrder === null && isReExtractableHeaderField(f.field)),
    [detail.uncertainFields]
  )

  const validationErrorCount =
    validationErrors.header.size +
    [...validationErrors.lineItems.values()].reduce((sum, s) => sum + s.size, 0)

  const editedFieldCount =
    editedFields.header.size + [...editedFields.lineItems.values()].reduce((sum, s) => sum + s.size, 0)

  // 5.16: advisory only -- a future invoice date is unusual, not invalid, so
  // this never blocks Save the way validationErrors does. No event-window
  // check here (plan §13's "or outside the event window" clause) -- this
  // codebase has no event-start/event-end config anywhere to check against;
  // build that check only once such a config exists.
  const invoiceDateWarning = useMemo(() => {
    const raw = invoiceDate.trim()
    if (!raw) return null
    return raw > todayLocalDateString() ? 'This invoice date is in the future.' : null
  }, [invoiceDate])

  // Pending action awaiting confirmation because it would discard unsaved
  // edits (re-extract, or navigating away). Reused for both so there is one
  // dialog and one place that decides "does this need confirming."
  const [confirmAction, setConfirmAction] = useState<
    { kind: 're-extract' } | { kind: 'navigate'; targetId: number; targetPage: number | null } | null
  >(null)

  // event-scoping-and-review-fixes-plan.md §2.4: "stop the vendor overwrite."
  // Selecting a vendor from the `/` picker no longer overwrites the on-screen
  // OCR vendor name -- it only links vendorId (see handleVendorSelect below).
  // When the OCR spelling differs from the selected vendor's own spelling,
  // this prompt offers to record the OCR spelling as a vendor_alias instead,
  // via the new confirmVendorAlias server action. Declining or accepting
  // either way never touches `header` -- only this dialog's own state.
  const [vendorAliasPrompt, setVendorAliasPrompt] = useState<{
    vendorId: number
    vendorDisplayName: string
    rawName: string
  } | null>(null)
  const [confirmingVendorAlias, setConfirmingVendorAlias] = useState(false)

  // Stage 3 (Classify, §8) -- string state + NONE sentinel, same pattern as
  // components/entries/detail/enrichment-form.tsx. Saved via
  // saveEntryClassification (lib/actions/review.ts), not saveEntryEnrichment
  // -- see that action's doc comment for why.
  const [adminHeadId, setAdminHeadId] = useState<string>(
    detail.entryAdminHeadId ? String(detail.entryAdminHeadId) : NONE
  )
  const [zoneId, setZoneId] = useState<string>(detail.entryZoneId ? String(detail.entryZoneId) : NONE)
  const [subDepartmentId, setSubDepartmentId] = useState<string>(
    detail.entrySubDepartmentId ? String(detail.entrySubDepartmentId) : NONE
  )

  // MatchStrip's attach/change actions call router.refresh() rather than
  // navigating (no key change), so this component doesn't remount when
  // `detail.entryId` changes mid-session -- re-seed explicitly whenever the
  // matched entry (or its classification) changes underneath us, otherwise
  // these two Selects would keep showing whatever was true for the
  // previously-attached (or no) entry.
  useEffect(() => {
    setAdminHeadId(detail.entryAdminHeadId ? String(detail.entryAdminHeadId) : NONE)
    setZoneId(detail.entryZoneId ? String(detail.entryZoneId) : NONE)
    setSubDepartmentId(detail.entrySubDepartmentId ? String(detail.entrySubDepartmentId) : NONE)
  }, [detail.entryId, detail.entryAdminHeadId, detail.entryZoneId, detail.entrySubDepartmentId])

  // Hub cert 2.6: seed from the claim snapshot review/page.tsx already loads
  // (detail.claimedBy*), so the common case -- an unclaimed bill, or one this
  // reviewer already holds -- renders straight into the live form instead of
  // flashing ClaimBanner's "Checking claim…" with every input disabled on
  // every queue navigation. The mount effect below still runs to actually
  // write/confirm the claim server-side; only the "someone else holds it"
  // case has to wait for that round trip (it needs the holder's display name,
  // which isn't in the snapshot).
  const [claimState, setClaimState] = useState<'checking' | 'mine' | 'blocked'>(() =>
    detail.claimedBy === null || detail.claimedByIsMe ? 'mine' : 'checking'
  )
  const [claimInfo, setClaimInfo] = useState<{ displayName: string; claimedAt: string } | null>(null)
  const [takingOver, setTakingOver] = useState(false)

  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [exceptionOpen, setExceptionOpen] = useState(false)
  const [hubStatusOpen, setHubStatusOpen] = useState(false)
  const [reExtracting, setReExtracting] = useState(false)
  const [addingLineItem, setAddingLineItem] = useState(false)
  // Phase 4 (§2.6): the one uncertain header field currently being
  // re-extracted (its wire name, e.g. 'vendor_name'), or null. Keyed by field
  // name rather than a single boolean so re-extracting one field never
  // disables the affordance on any other flagged field.
  const [reExtractingField, setReExtractingField] = useState<string | null>(null)

  const [isSaving, startSaving] = useTransition()

  // L1 -- PDF pane mode (checklist 3.4-3.10). Lazy initializers read
  // localStorage once, guarded for SSR (this component is 'use client' but
  // Next.js still evaluates the initial render pass server-side).
  const [paneMode, setPaneMode] = useState<PdfPaneMode>(readStoredPaneMode)
  const [splitPercent, setSplitPercent] = useState<number>(readStoredSplitPercent)
  const [isDraggingDivider, setIsDraggingDivider] = useState(false)
  const paneContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.localStorage.setItem(PANE_MODE_KEY, paneMode)
  }, [paneMode])

  useEffect(() => {
    window.localStorage.setItem(PANE_SPLIT_KEY, String(splitPercent))
  }, [splitPercent])

  // \ cycles Split -> Collapsed -> Document -> Split. Snaps to each mode's
  // canonical ratio -- the drag handler below is what makes the ratio
  // continuous in between.
  function cyclePaneMode() {
    const next: PdfPaneMode = paneMode === 'split' ? 'collapsed' : paneMode === 'collapsed' ? 'document' : 'split'
    setPaneMode(next)
    if (next === 'split' || next === 'document') {
      setSplitPercent(PANE_MODE_DEFAULT_SPLIT[next])
    }
  }

  // 5.2: stable identity required so memo(ExtractionForm) can skip
  // re-rendering on every keystroke -- a functional setPaneMode update means
  // this never needs `paneMode` itself as a dependency.
  const onJumpToPage = useCallback((pageNumber: number) => {
    pdfViewerRef.current?.goToPage(pageNumber)
    // Checklist 3.10: a collapsed spine can't actually show the page being
    // jumped to -- expand so the reviewer can see it.
    setPaneMode((current) => {
      if (current !== 'collapsed') return current
      setSplitPercent(PANE_MODE_DEFAULT_SPLIT.split)
      return 'split'
    })
  }, [])

  // 5.2: stable identity so memo(PdfViewer) doesn't see a new array (and
  // re-render) on every keystroke -- only recompute when the sibling-bill
  // list itself actually changes.
  const billPageRanges = useMemo(
    () =>
      detail.siblingBills.map((b) => ({
        documentExtractionId: b.documentExtractionId,
        pageNumberStart: b.pageNumberStart,
        pageNumberEnd: b.pageNumberEnd,
      })),
    [detail.siblingBills]
  )

  function handleDividerPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setIsDraggingDivider(true)
  }

  function handleDividerPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!isDraggingDivider) return
    const container = paneContainerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const percent = ((e.clientX - rect.left) / rect.width) * 100
    setSplitPercent(Math.min(SPLIT_PERCENT_BOUNDS.max, Math.max(SPLIT_PERCENT_BOUNDS.min, percent)))
  }

  function handleDividerPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    setIsDraggingDivider(false)
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // Hub cert 1.8 ("Never released"): tracks whether THIS component instance
  // actually holds the claim server-side -- set true by the mount effect
  // below on a genuine claim success, and by handleTakeOver on a successful
  // takeover. A ref (not state) because it's read from the mount effect's
  // own cleanup, which must see the latest value without re-running the
  // effect itself.
  const claimedByMeRef = useRef(false)

  // Claim/lock (§7): attempt to claim on mount; surface a takeover prompt
  // instead of silently overwriting someone else's active claim. Cleanup
  // (hub cert 1.8, "Never released") fires a best-effort release when this
  // document is left behind -- either this component unmounts, or the
  // effect re-runs for a different sourceDocumentId (Prev/Next/queue
  // navigation, which all remount via a key change or update this same
  // prop). Not awaited: there is no unmount-safe "keep this request alive
  // after the component is gone" primitive for a server action the way
  // navigator.sendBeacon gives a plain fetch, so a lost release just means
  // the claim sits until its own 15-minute staleness window lapses --
  // today's existing fallback, not a regression.
  useEffect(() => {
    let cancelled = false
    const sourceDocumentId = detail.sourceDocumentId
    claimedByMeRef.current = false
    // No setClaimState('checking') here -- the initial state is already
    // seeded from detail.claimedBy* (hub cert 2.6), and this component
    // remounts (keyed) on every queue navigation, so the initializer re-runs
    // for each document. Forcing 'checking' would just re-introduce the
    // per-navigation disabled-form flash this item removed.
    void claimReviewDocument(sourceDocumentId).then((result) => {
      if (cancelled) return
      if (result.ok) {
        claimedByMeRef.current = true
        setClaimState('mine')
        return
      }
      if ('needsTakeover' in result && result.needsTakeover) {
        setClaimState('blocked')
        setClaimInfo({ displayName: result.claimedByDisplayName, claimedAt: result.claimedAt })
        return
      }
      // Transient error (network, etc.) -- fail open rather than locking the
      // reviewer out of a document they can otherwise see. No claim was
      // actually written server-side on this path, so claimedByMeRef stays
      // false and the cleanup below correctly skips releasing.
      toastError(result.error, { context: 'review-workspace' })
      setClaimState('mine')
    })
    return () => {
      cancelled = true
      if (claimedByMeRef.current) {
        void releaseReviewDocument(sourceDocumentId)
      }
    }
  }, [detail.sourceDocumentId])

  // Hub cert 1.8 ("Never refreshed"): while this reviewer actively holds the
  // claim, periodically re-issue the same atomic claim update (own-claim
  // branch: claimed_by already equals us, so it always succeeds) to refresh
  // claimed_at. Without this, stepping between several bills of one
  // multi-page PDF -- or just reading/thinking without saving -- for more
  // than 15 minutes lets the claim go stale out from under an active
  // reviewer, and a colleague's claim attempt silently wins with no prompt
  // on either side. 5 minutes keeps claimed_at comfortably inside the
  // 15-minute staleness window (CLAIM_STALE_AFTER_MS, lib/actions/review.ts)
  // even if one tick is delayed. Cleared whenever the claim isn't (or is no
  // longer) held, and re-created for a new document via the sourceDocumentId
  // dependency.
  useEffect(() => {
    if (claimState !== 'mine') return
    const sourceDocumentId = detail.sourceDocumentId
    const interval = setInterval(() => {
      void claimReviewDocument(sourceDocumentId).then((result) => {
        if (result.ok) return
        // Heartbeat lost the claim (e.g. an admin forced a takeover while
        // this reviewer was idle) -- surface it the same way any other
        // claim loss would be, rather than leaving the form editable while
        // the server no longer honors it.
        if ('needsTakeover' in result && result.needsTakeover) {
          claimedByMeRef.current = false
          setClaimState('blocked')
          setClaimInfo({ displayName: result.claimedByDisplayName, claimedAt: result.claimedAt })
        }
      })
    }, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [claimState, detail.sourceDocumentId])

  // Redesign point 4: "Document N of M" nav, distinct from "Bill N of M" --
  // jumps straight to the next/previous UPLOADED PDF (sourceDocumentId)
  // instead of stepping through every bill inside the current one first.
  // `queue` is already ordered by severity/confidence/amount (review/page.tsx);
  // "distinct" here just means first-occurrence order within that same
  // ordering, so a multi-bill PDF's several queue rows collapse to one entry.
  const documentNav = useMemo(() => {
    const order: number[] = []
    const seen = new Set<number>()
    for (const q of queue) {
      if (!seen.has(q.sourceDocumentId)) {
        seen.add(q.sourceDocumentId)
        order.push(q.sourceDocumentId)
      }
    }
    const index = order.indexOf(detail.sourceDocumentId)
    if (index === -1) return null // e.g. the out-of-scope-id path in review/page.tsx
    const firstExtractionIdFor = (sourceDocumentId: number) =>
      queue.find((q) => q.sourceDocumentId === sourceDocumentId)?.documentExtractionId ?? null
    return {
      index,
      total: order.length,
      prevId: index > 0 ? firstExtractionIdFor(order[index - 1]!) : null,
      nextId: index < order.length - 1 ? firstExtractionIdFor(order[index + 1]!) : null,
    }
  }, [queue, detail.sourceDocumentId])

  // 2.3: on Save, work this PDF to completion before letting the
  // (severity-ordered, possibly cross-document) global queue take over --
  // the lowest bill_index among this document's still-unverified siblings
  // (excluding this bill itself, which detail.siblingBills still shows as
  // unverified since it reflects state as of this page load, before the
  // save that's about to happen). null once every other bill in this
  // document is already verified, which is when handleSave below falls back
  // to the queue and shows the "document complete" toast.
  const nextSiblingId = useMemo(() => {
    const unverified = detail.siblingBills.filter(
      (b) => b.documentExtractionId !== detail.documentExtractionId && b.verifiedAt === null
    )
    if (unverified.length === 0) return null
    return unverified.reduce((min, b) => (b.billIndex < min.billIndex ? b : min)).documentExtractionId
  }, [detail.siblingBills, detail.documentExtractionId])

  // 5.2: stable identity -- this is passed down (via handleRequestBillSwitch
  // below) as PdfViewer's onRequestBillSwitch prop, and PdfViewer is now
  // memoized (5.2, pdf-viewer.tsx). `router` is stable across renders (Next's
  // App Router guarantee), so `[router]` is enough to keep this from ever
  // changing identity mid-mount.
  const goToDocument = useCallback(
    (id: number | null, page?: number | null) => {
      if (id === null) {
        toast.info('No more documents in that direction.')
        return
      }
      router.push(`/review?id=${id}${page ? `&page=${page}` : ''}`)
    },
    [router]
  )

  // Guarded entry point for Prev/Next/PgUp/PgDn (checklist 1.8): today
  // `goToDocument` discards unsaved edits the instant the target component
  // remounts. Route every navigation call site through this instead so a
  // dirty form always confirms first. `page` carries a specific target page
  // through the confirm dialog too -- used by handleRequestBillSwitch below
  // when a reviewer clicks a sibling bill's page in the thumbnail rail.
  //
  // 5.2/5.5: reads hasEditedRef.current directly rather than closing over
  // the render-scoped `dirty` const, so this function's own identity can
  // stay stable ([]-ish deps below) without ever going stale -- a stale
  // `dirty` captured at definition time would silently stop confirming once
  // the form became dirty after this closure was created.
  const requestGoToDocument = useCallback(
    (id: number | null, page?: number | null) => {
      if (id === null) {
        toast.info('No more documents in that direction.')
        return
      }
      if (hasEditedRef.current) {
        setConfirmAction({ kind: 'navigate', targetId: id, targetPage: page ?? null })
        return
      }
      goToDocument(id, page)
    },
    [goToDocument]
  )

  // PdfViewer's thumbnail rail shows every page of the shared source PDF,
  // including sibling bills' own pages -- clicking one that isn't in this
  // bill's own page range should switch the whole workspace (OCR form
  // included) to whichever bill actually owns that page, landing on it
  // directly, rather than just scrolling the canvas to a page whose data
  // isn't the one on screen.
  //
  // 5.2: stable identity -- passed to PdfViewer (now memoized) as
  // onRequestBillSwitch.
  const handleRequestBillSwitch = useCallback(
    (targetDocumentExtractionId: number, pageNumber: number) => {
      requestGoToDocument(targetDocumentExtractionId, pageNumber)
    },
    [requestGoToDocument]
  )

  // Guarded entry point for re-extract (checklist 1.6): always confirms
  // first, not just when there are unsaved edits to lose -- forcing a new
  // Sonnet run costs real money on every call regardless of dirty state, so
  // it should never fire straight from a keypress or a menu click.
  function requestReExtract() {
    setConfirmAction({ kind: 're-extract' })
  }

  function confirmPendingAction() {
    if (!confirmAction) return
    if (confirmAction.kind === 're-extract') {
      void handleReExtract()
    } else {
      goToDocument(confirmAction.targetId, confirmAction.targetPage)
    }
    setConfirmAction(null)
  }

  function handleTakeOver() {
    setTakingOver(true)
    void claimReviewDocument(detail.sourceDocumentId, { takeover: true }).then((result) => {
      setTakingOver(false)
      if (result.ok) {
        // So the mount effect's cleanup (hub cert 1.8) releases this claim
        // on navigate-away/unmount too, not just a claim won on first load.
        claimedByMeRef.current = true
        setClaimState('mine')
        toast.success('Claim taken over.')
      } else if ('error' in result) {
        toastError(result.error, { context: 'review-workspace' })
      }
    })
  }

  function buildSavePayload(): SaveVerificationInput {
    return {
      sourceDocumentId: detail.sourceDocumentId,
      documentExtractionId: detail.documentExtractionId,
      header: {
        vendor_name: header.vendorName.trim() || null,
        vendor_gstin: header.vendorGstin.trim() || null,
        vendor_phone: header.vendorPhone.trim() || null,
        vendor_email: header.vendorEmail.trim() || null,
        vendor_address: header.vendorAddress.trim() || null,
        buyer_gstin: header.buyerGstin.trim() || null,
        buyer_name: header.buyerName.trim() || null,
        invoice_number: header.invoiceNumber.trim() || null,
        invoice_date: header.invoiceDate.trim() || null,
        subtotal: parseNum(header.subtotal),
        tax_amount: parseNum(header.taxAmount),
        total_amount: parseNum(header.totalAmount),
        notes: header.notes.trim() || null,
      },
      lineItems: lineItems.map((li) => {
        const rawUnit = (li.unitNormalized || li.unit).trim()
        return {
          id: li.id,
          description: li.description.trim() || null,
          hsn_sac_code: li.hsnSacCode.trim() || null,
          quantity: parseNum(li.quantity),
          quantity_raw_text: li.quantityRawText.trim() || null,
          unit: li.unit.trim() || null,
          unit_normalized: rawUnit ? normalizeUnit(rawUnit) : null,
          rate: parseNum(li.rate),
          discount: li.discount.trim() || null,
          amount: parseNum(li.amount),
        }
      }),
      vendorId,
      // 5.18: the extraction run this form was built from. The RPC compares
      // this against document_extraction.current_extraction_run_id at save
      // time and raises SAVE_CONFLICT if a re-extraction moved the document
      // on since this page loaded -- see saveVerification's conflict check.
      expectedExtractionRunId: detail.currentExtractionRunId,
    }
  }

  function handleSave() {
    if (claimState === 'blocked') {
      toast.error('Take over the claim before saving.')
      return
    }
    // 5.15: block save outright when any amount-shaped field couldn't be
    // parsed as a number -- saving it anyway would silently write null with
    // no further warning (the bug this whole item exists to close). Jump to
    // the first offending field the same way the codebase already jumps to a
    // flagged field elsewhere, just keyed off a boolean data attribute
    // (data-validation-error) rather than an index -- there's nothing to
    // step between here, only ever "the first one."
    if (validationErrorCount > 0) {
      toast.error(
        `Fix ${validationErrorCount} invalid amount field${validationErrorCount === 1 ? '' : 's'} before saving.`
      )
      formContainerRef.current?.querySelector<HTMLElement>('[data-validation-error="true"]')?.focus()
      return
    }
    startSaving(async () => {
      const result = await saveVerification(buildSavePayload())
      if (!result.ok) {
        // 5.18: a save conflict is a different situation from a generic
        // save failure -- the reviewer's corrections are still good, but the
        // document underneath them has moved on, so a vanishing toast isn't
        // enough (they'd lose the thread of what happened). Pin it open with
        // an explicit Reload action instead of the default auto-dismiss.
        if ('conflict' in result && result.conflict) {
          toast.error('This document was re-extracted since you opened it.', {
            description: 'Reload to see the latest version before saving your corrections.',
            duration: Infinity,
            action: { label: 'Reload', onClick: () => router.refresh() },
          })
          return
        }
        toastError(result.error, { context: 'review-workspace' })
        return
      }

      // Stage 3 rides the same save (§8, "all three stages commit on the
      // same Ctrl/Cmd+Enter") -- non-blocking per the plan, so a failure
      // here surfaces a toast but does not undo the verification save or
      // stop navigation to the next document.
      if (detail.entryId !== null) {
        const classificationResult = await saveEntryClassification({
          entryId: detail.entryId,
          adminHeadId: adminHeadId === NONE ? null : Number(adminHeadId),
          zoneId: zoneId === NONE ? null : Number(zoneId),
          subDepartmentId: subDepartmentId === NONE ? null : Number(subDepartmentId),
        })
        if (!classificationResult.ok) {
          toastError(classificationResult.error, {
            title: 'Saved, but admin head/zone/sub-department could not be saved.',
            context: 'review-workspace',
          })
        }
      }

      toast.success(
        result.rateReferenceRowsInserted > 0
          ? `Saved -- ${result.rateReferenceRowsInserted} rate reference row(s) recorded.`
          : 'Saved.'
      )
      // 2.3: prefer the next unverified bill in THIS document over whatever
      // the severity-ordered global queue would send us to next -- the
      // queue's own nextId (used by the manual "Next bill" nav button
      // above) can point at an entirely different PDF, which fought the
      // "work one PDF to completion" workflow. Only fall back to the queue
      // once this document has nothing left to verify.
      if (nextSiblingId !== null) {
        router.push(`/review?id=${nextSiblingId}`)
      } else {
        toast.success('Document complete -- every bill in this PDF has been reviewed.')
        router.push('/review')
      }
    })
  }

  async function handleReExtract() {
    setReExtracting(true)
    try {
      const res = await fetch('/api/documents/reescalate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: detail.sourceDocumentId }),
      })
      const json = await res.json()
      if (!res.ok) {
        toastError(json.error, { title: 'Re-extraction failed.', context: 'review-workspace' })
        return
      }
      toast.success(
        `Re-extracted with ${json.model} — ${json.lineItemCount} line item(s)${json.billCount > 1 ? ` across ${json.billCount} bill(s)` : ''}.`
      )
      router.refresh()
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err), { context: 'review-workspace' })
    } finally {
      setReExtracting(false)
    }
  }

  // Phase 4 (§2.6): re-extract ONE flagged header field. Deliberately does
  // NOT call router.refresh() -- reExtractField's own doc comment
  // (lib/actions/review.ts) spells out why: a refresh would re-fetch
  // ReviewDocumentDetail with a bumped currentExtractionRunId, which (per
  // 5.7's reset-on-prop-change block above) would reset every header/
  // line-item field back to its fresh-extraction baseline and discard any
  // unsaved edits to every OTHER field -- exactly the bug this feature
  // exists to avoid. Instead this patches only that one key of local
  // `header` state, leaving everything else (including that same field's
  // own dirty/edited status relative to the ORIGINAL ocr baseline)
  // untouched.
  async function handleReExtractField(wireField: string) {
    if (!isReExtractableHeaderField(wireField)) return
    const headerKey = UNCERTAIN_FIELD_TO_HEADER_KEY[wireField]
    if (!headerKey) return
    setReExtractingField(wireField)
    try {
      const result = await reExtractField({ documentExtractionId: detail.documentExtractionId, field: wireField })
      if (!result.ok) {
        toastError(result.error, { context: 'review-workspace' })
        return
      }
      // 5.1: header is now per-field state, so this reuses onHeaderChange's
      // own field->setter switch instead of a spread over a single object.
      onHeaderChange(headerKey, numToStr(result.newValue))
      toast.success(`Re-extracted ${(UNCERTAIN_FIELD_LABEL[wireField] ?? wireField).toLowerCase()}.`)
    } finally {
      setReExtractingField(null)
    }
  }

  // 5.21: the empty-line-items state's "Add a row" action. Inserts one blank
  // row server-side (lib/actions/review.ts's addLineItem, RLS-gated the same
  // way flagReviewException's insert is) and appends it to local state in
  // buildLineItemState's own shape -- empty strings for every text field --
  // so it's immediately editable and behaves like any other row on the next
  // Save, no special-casing in buildSavePayload.
  async function handleAddLineItem() {
    setAddingLineItem(true)
    const result = await addLineItem(detail.documentExtractionId)
    setAddingLineItem(false)
    if (!result.ok) {
      toastError(result.error, { context: 'review-workspace' })
      return
    }
    // 5.4: adding a row is an edit like any other -- the old stringify-based
    // dirty check would have caught this via lineItems diverging from its
    // initial snapshot; the ref latch needs the same flip made explicit.
    hasEditedRef.current = true
    setLineItems((items) => [
      ...items,
      {
        id: result.lineItem.id,
        lineOrder: result.lineItem.lineOrder,
        description: '',
        hsnSacCode: '',
        quantity: '',
        quantityRawText: '',
        unit: '',
        unitNormalized: '',
        rate: '',
        discount: '',
        amount: '',
      },
    ])
  }

  function handleFieldEnter(target: HTMLElement) {
    const container = formContainerRef.current
    if (!container) return
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>('input:not([disabled]), textarea:not([disabled]), [role="combobox"]:not([disabled])')
    )
    const idx = focusables.indexOf(target)
    if (idx >= 0 && idx < focusables.length - 1) {
      focusables[idx + 1]!.focus()
    }
  }

  function handleVendorSelect(vendor: VendorSearchResult) {
    // §2.4: linking a vendor must never overwrite what OCR actually read off
    // the bill -- header.vendorName (and vendorGstin) stay exactly as
    // extracted, regardless of which vendor gets linked.
    setVendorId(vendor.id)

    const rawName = header.vendorName.trim()
    if (!rawName) return // nothing to learn from an empty OCR field

    const normalizedOcr = normalizeVendorName(rawName)
    const normalizedVendor = normalizeVendorName(vendor.displayName)
    if (!normalizedOcr || normalizedOcr === normalizedVendor) return // already the same spelling

    setVendorAliasPrompt({ vendorId: vendor.id, vendorDisplayName: vendor.displayName, rawName })
  }

  async function handleConfirmVendorAlias() {
    if (!vendorAliasPrompt) return
    setConfirmingVendorAlias(true)
    const result = await confirmVendorAlias({ vendorId: vendorAliasPrompt.vendorId, rawName: vendorAliasPrompt.rawName })
    setConfirmingVendorAlias(false)
    setVendorAliasPrompt(null)
    if (!result.ok) {
      toastError(result.error, { context: 'review-workspace' })
    }
  }

  function openHubStatus() {
    if (!detail.canSetHubStatus || detail.entryId === null) {
      toast.error(
        'This document is not matched to an entry yet, so there is no Hub status to set. Connect it to a ledger entry first.'
      )
      return
    }
    setHubStatusOpen(true)
  }

  // Global keyboard contract (§7, remapped per plan §2.1). Cmd/Ctrl-Enter
  // saves everywhere, including inside a field. Everything else only fires
  // when focus sits somewhere "safe" (isSafeShortcutTarget -- body, or an
  // element explicitly opted in via data-shortcut-safe): an allowlist,
  // replacing the old denylist that let a click landing on a button or
  // label leave shortcuts armed.
  // 5.5: the actual handler logic lives in a ref, reassigned fresh on every
  // render (see the registration effect below) rather than closed over by a
  // listener that gets torn down and rebuilt every render. This keeps
  // header/lineItems/claimState/etc. always current inside the handler
  // without ever touching the DOM listener itself after the first mount.
  const handleKeyDownRef = useRef<(e: KeyboardEvent) => void>(() => {})
  handleKeyDownRef.current = function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        handleSave()
        return
      }

      // Hub cert 2.2: the bare navigation keys (PageUp/PageDown, arrows)
      // would fight typing or a field's own caret movement, so they stay
      // gated to a "safe" focus target -- body, or a data-shortcut-safe
      // element. The configurable commands further down are all Alt-gated
      // (lib/shortcuts/config.ts) -- Alt+letter is a combination normal
      // typing and text editing never produce -- so they must keep working
      // while the cursor sits in a field, which is the normal state for a
      // whole review session. Before this, tabbing into any input silently
      // disarmed every shortcut until the reviewer clicked empty background.
      if (isSafeShortcutTarget(document.activeElement)) {
        // Always-on navigation: PageUp/PageDown/arrow-key PDF paging are core
        // navigation, not "shortcuts" a user would think to disable via the
        // master toggle, so these run regardless of shortcutsEnabled.
        if (e.key === 'PageDown') {
          e.preventDefault()
          requestGoToDocument(nextId)
          return
        }
        if (e.key === 'PageUp') {
          e.preventDefault()
          requestGoToDocument(prevId)
          return
        }
        // Page navigation within the open document -- all four arrows work so
        // either hand's natural rest position reaches one.
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault()
          pdfViewerRef.current?.nextPage()
          return
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault()
          pdfViewerRef.current?.prevPage()
          return
        }
      }

      // Configurable commands, gated by the master enable/disable (plan
      // §2.1). Each trigger is looked up in the resolved keymap rather than
      // hardcoded, so a staff member's remaps take effect immediately. All
      // are Alt-gated, so they deliberately fire even with a field focused.
      if (!shortcutsEnabled) return

      if (matchesBinding(e, keymap.toggleHelp)) {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
        return
      }
      // PDF pane mode (L1, checklist 3.5): Split -> Collapsed -> Document -> Split.
      if (matchesBinding(e, keymap.cyclePane)) {
        e.preventDefault()
        cyclePaneMode()
        return
      }
      if (matchesBinding(e, keymap.openException)) {
        e.preventDefault()
        setExceptionOpen(true)
        return
      }
      // Re-extract moved off the bare letter (D3, checklist 1.6): this
      // forces a new Sonnet run and, via review/page.tsx's run-id key,
      // remounts the whole workspace from the database -- previously a
      // single unmodified `r` silently discarded every unsaved correction.
      // Alt+R (default) always confirms before running (requestReExtract
      // below) -- forcing a new Sonnet run costs real money and, via
      // review/page.tsx's run-id key, remounts the whole workspace from the
      // database, discarding any unsaved corrections.
      if (matchesBinding(e, keymap.reExtract)) {
        e.preventDefault()
        requestReExtract()
        return
      }
      if (matchesBinding(e, keymap.openHubStatus)) {
        e.preventDefault()
        openHubStatus()
        return
      }
      if (matchesBinding(e, keymap.openVendorAutocomplete)) {
        e.preventDefault()
        setVendorAutocompleteOpen(true)
        return
      }
      if (matchesBinding(e, keymap.focusZone)) {
        e.preventDefault()
        document.getElementById('stage3-zone-select')?.focus()
        return
      }
      if (matchesBinding(e, keymap.focusAdminHead)) {
        e.preventDefault()
        document.getElementById('stage3-admin-head-select')?.focus()
        return
      }
      if (matchesBinding(e, keymap.focusSubDepartment)) {
        e.preventDefault()
        document.getElementById('stage3-sub-department-select')?.focus()
        return
      }
      const lineIndex = matchLineDigit(e, keymap.jumpToLineDigit)
      if (lineIndex !== null) {
        e.preventDefault()
        const target = formContainerRef.current?.querySelector<HTMLElement>(`[data-line-jump-index="${lineIndex}"]`)
        target?.focus()
      }
  }

  // 5.5: register the DOM listener exactly once. Previously this effect ran
  // with no dependency array, so at this component's keystroke-driven render
  // rate it performed an addEventListener/removeEventListener pair on
  // `window` per character typed anywhere in the form. The listener below
  // never changes identity -- it just forwards to whatever
  // handleKeyDownRef.current currently points at (reassigned above on every
  // render), so the logic is always fresh without the DOM churn.
  useEffect(() => {
    function listener(e: KeyboardEvent) {
      handleKeyDownRef.current(e)
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  // Tab-close/refresh guard (checklist 1.7): most browsers ignore the
  // custom string and show their own generic warning, but setting
  // `returnValue` is what triggers that prompt at all.
  useEffect(() => {
    if (!dirty) return
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirty])

  // 5.6: memoized, matching editedFields/validationErrors just above -- this
  // re-parses every line item's amount string, and was previously
  // recomputed on every render (including a render triggered by an
  // unrelated header keystroke) with no memoization at all.
  const lineItemSum = useMemo(
    () => (lineItems.length > 0 ? lineItems.reduce((sum, li) => sum + (parseNum(li.amount) ?? 0), 0) : null),
    [lineItems]
  )
  const documentTotal = parseNum(totalAmount)

  // Redesign point 2: confidence/model/legibility/edited-count/bill-position
  // used to be five-plus separately-colored pills competing for attention.
  // Only the open-exceptions pill stays an actual colored badge below (that's
  // the one thing genuinely asking the reviewer to act) -- these are now
  // plain informational text, concatenated with the same " · " separator the
  // old confidence pill used internally.
  const toolbarInfoParts: string[] = []
  if (detail.extractionConfidence !== null) {
    toolbarInfoParts.push(`${Math.round(detail.extractionConfidence * 100)}% confidence`)
  } else if (detail.model || detail.legibility) {
    toolbarInfoParts.push('Confidence unknown')
  }
  if (detail.model) toolbarInfoParts.push(detail.model)
  if (detail.legibility) toolbarInfoParts.push(detail.legibility)
  if (editedFieldCount > 0) toolbarInfoParts.push(`${editedFieldCount} changed from OCR`)
  if (detail.billCount > 1) toolbarInfoParts.push(`Bill ${detail.billIndex + 1} of ${detail.billCount} in this PDF`)
  // Hub cert 2.6: the Hub status is loaded (detail.hubStatusCode) but was
  // never surfaced anywhere the reviewer can see without opening the Hub
  // status dialog. Show its human label when set.
  if (detail.hubStatusCode) {
    const hubStatusLabel =
      detail.hubStatusOptions.find((o) => o.code === detail.hubStatusCode)?.label ?? detail.hubStatusCode
    toolbarInfoParts.push(`Hub: ${hubStatusLabel}`)
  }
  const toolbarInfoText = toolbarInfoParts.join(' · ')
  // 5.19: 'checking' was missing here -- the ClaimBanner visually gates the
  // form while "Checking claim…" is in flight, but the inputs themselves
  // stayed live underneath it, so a fast typist could get edits in before the
  // claim result even came back.
  const formDisabled = claimState === 'blocked' || claimState === 'checking'

  // Three-stage review flow (§8) -- legibility only, never gates Save.
  // Stage 2 (Connect) gates stage 3 (Classify) becoming reachable; stage 1
  // (Verify) has no hard gate of its own, it just reads as "done" once
  // there's a match to move past.
  const stage2Done = detail.entryId !== null
  const stage3Done = stage2Done && adminHeadId !== NONE && zoneId !== NONE && subDepartmentId !== NONE
  const verifyStatus: StageStatus = stage2Done ? 'done' : 'current'
  const connectStatus: StageStatus = stage2Done ? 'done' : 'current'
  const classifyStatus: StageStatus = !stage2Done ? 'blocked' : stage3Done ? 'done' : 'current'

  // Hub cert 2.4: land focus inside the form on every queue advance
  // (didInitialFocusRef itself is declared near the top of this component --
  // see 5.7's comment there for why it moved). The workspace used to remount
  // per document + extraction run in review/page.tsx, so a mount there WAS a
  // queue advance; 5.7 changed the key to sourceDocumentId, so a bill switch
  // no longer remounts this component -- detail.documentExtractionId is now
  // in this effect's own dependency array (in addition to the bill-switch
  // reset block resetting the ref to false) so a switch to a sibling bill
  // still re-runs this even when detail.uncertainFields.length happens to
  // coincidentally match the previous bill's. Without this every bill starts
  // with a reach for the mouse, the single biggest tax on a throughput
  // screen. Priority: first flagged (uncertain) field, else the first
  // line-item jump target, else the first input. Gated on !formDisabled so
  // focus doesn't land on an input the claim check is about to disable; the
  // ref keeps it a one-shot even though formDisabled can flip more than once.
  useEffect(() => {
    if (didInitialFocusRef.current || formDisabled) return
    didInitialFocusRef.current = true
    const container = formContainerRef.current
    if (!container) return
    if (detail.uncertainFields.length > 0) {
      setUncertainStepIndex(0)
      focusUncertainField(0)
      return
    }
    const firstLineJump = container.querySelector<HTMLElement>('[data-line-jump-index="1"]')
    if (firstLineJump) {
      firstLineJump.focus()
      return
    }
    container
      .querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), [role="combobox"]:not([disabled])'
      )
      ?.focus()
  }, [formDisabled, detail.uncertainFields.length, detail.documentExtractionId])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <ClaimBanner
        status={claimState}
        claimedByDisplayName={claimInfo?.displayName ?? null}
        claimedAt={claimInfo?.claimedAt ?? null}
        onTakeOver={handleTakeOver}
        isPending={takingOver}
      />

      {/* Redesign (top-chrome mockup, approved): the old toolbar row and
          nav-cluster row merge into ONE row here -- Save/Flag/More, Bill nav,
          Document nav, the open-exceptions pill (the only badge left with an
          actual call to action), then everything else as plain right-aligned
          muted text. Page-nav (Prev/Next page + "Page N/M") and the
          sibling-bill circular-pill picker are gone entirely: the PdfViewer's
          own thumbnail rail already covers page navigation, and the sibling
          picker was extra, per the design review. */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
        <Button type="button" size="sm" onClick={handleSave} disabled={isSaving || formDisabled}>
          {isSaving ? 'Saving…' : 'Save (Ctrl/Cmd+Enter)'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setExceptionOpen(true)} disabled={formDisabled}>
          Flag exception ({formatBinding(keymap.openException)})
        </Button>
        {/* Plan §3: Re-extract/Hub status are deliberate, occasional
            overrides -- kept behind "More" so they don't compete for
            attention with Save/Flag on every ordinary bill. Shortcuts (?)
            folds in here too now, freeing up a toolbar slot for Document nav. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              More
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={requestReExtract} disabled={reExtracting}>
              {/* Named because this control forces Sonnet, unlike the
                  Documents inbox's "Extract now (Haiku)" — and Sonnet costs
                  materially more per document, so the choice should be
                  deliberate. */}
              {reExtracting
                ? 'Re-extracting…'
                : `Re-extract with Sonnet (${formatBinding(keymap.reExtract)})`}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={openHubStatus} disabled={!detail.canSetHubStatus || formDisabled}>
              Hub status ({formatBinding(keymap.openHubStatus)})
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setShortcutsOpen(true)}>
              Shortcuts ({formatBinding(keymap.toggleHelp)})
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="h-5 w-px bg-border" />

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0"
          disabled={prevId === null}
          onClick={() => requestGoToDocument(prevId)}
          aria-label="Previous bill"
          title="Previous bill (PgUp)"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-xs text-muted-foreground">
          {currentIndex < 0 ? 'Bill (outside current queue)' : `Bill ${currentIndex + 1} of ${queue.length}`}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0"
          disabled={nextId === null}
          onClick={() => requestGoToDocument(nextId)}
          aria-label="Next bill"
          title="Next bill (PgDn)"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>

        <div className="h-5 w-px bg-border" />

        {/* Redesign point 4: "Document N of M" -- jumps across distinct
            uploaded PDFs (sourceDocumentId), not just bills inside the
            current one. Computed from `queue`'s sourceDocumentId in
            documentNav above; routed through the same requestGoToDocument
            Prev/Next bill already use (deliberate -- see requestGoToDocument's
            doc comment and app/(app)/review/page.tsx's header comment for
            the single-route/server-reload rationale). */}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0"
          disabled={documentNav === null || documentNav.prevId === null}
          onClick={() => requestGoToDocument(documentNav?.prevId ?? null)}
          aria-label="Previous document"
          title="Previous document"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-xs text-muted-foreground">
          {documentNav ? `Document ${documentNav.index + 1} of ${documentNav.total}` : 'Document (outside current queue)'}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0"
          disabled={documentNav === null || documentNav.nextId === null}
          onClick={() => requestGoToDocument(documentNav?.nextId ?? null)}
          aria-label="Next document"
          title="Next document"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>

        {/* Redesign point 2: the ONE pill that stays an actual colored badge
            -- open exceptions are the one thing genuinely asking the
            reviewer to act. Everything else in this row is plain text.
            Hub cert 2.5: severity now drives the badge colour (shared
            severityBadgeVariant, same as the Exceptions screen) instead of a
            single amber for all three, and each carries an aria-label so a
            screen reader announces the severity and what the exception is. */}
        {detail.openExceptions.map((ex) => (
          <Badge
            key={ex.id}
            variant={severityBadgeVariant(ex.severity)}
            title={ex.description ?? undefined}
            aria-label={`${ex.severity} severity: ${exceptionTypeLabel(ex.exceptionType)}`}
          >
            {ex.severity.toUpperCase()} · {ex.exceptionType.replace(/_/g, ' ')}
          </Badge>
        ))}

        {/* Hub cert 2.6: detail.verifiedAt is loaded but was never shown, so
            in the "All" queue scope a verified bill looked identical to a
            pending one. */}
        {detail.verifiedAt ? (
          <Badge variant="success" title={`Verified ${formatDateTime(detail.verifiedAt)}`}>
            Verified {formatDateTime(detail.verifiedAt)}
          </Badge>
        ) : null}

        {toolbarInfoText ? <span className="ml-auto text-xs text-muted-foreground">{toolbarInfoText}</span> : null}
      </div>

      {/* Plan §4: one card, one row, three segments (Verify/Connect/Classify)
          -- replaces StageProgress's chip row, the standalone MatchStrip
          card, and the standalone bottom Classify bar that used to sit below
          TallyFooter. Every value/handler here is lifted from this
          component's own state; ReviewStatusLine owns none of it. */}
      <ReviewStatusLine
        keymap={keymap}
        verifyStatus={verifyStatus}
        vendorName={header.vendorName}
        vendorId={vendorId}
        onOpenVendorPicker={() => setVendorAutocompleteOpen(true)}
        uncertainFields={detail.uncertainFields}
        uncertainStepIndex={uncertainStepIndex}
        onStepUncertainField={stepUncertainField}
        formDisabled={formDisabled}
        connectStatus={connectStatus}
        documentExtractionId={detail.documentExtractionId}
        sourceDocumentId={detail.sourceDocumentId}
        entryId={detail.entryId}
        entryUbblNumber={detail.entryUbblNumber}
        entryDepartmentName={detail.entryDepartmentName}
        entryAmount={detail.entryAmount}
        matchCandidates={detail.matchCandidates}
        onMatchChanged={() => router.refresh()}
        classifyStatus={classifyStatus}
        stage2Done={stage2Done}
        adminHeadId={adminHeadId}
        zoneId={zoneId}
        onAdminHeadChange={setAdminHeadId}
        onZoneChange={setZoneId}
        adminHeadOptions={detail.adminHeadOptions}
        zoneOptions={detail.zoneOptions}
        subDepartmentId={subDepartmentId}
        onSubDepartmentChange={setSubDepartmentId}
        subDepartmentOptions={detail.subDepartmentOptions}
      />

      {/* Phase 4 (§2.6): one small button per flagged header field, re-running
          OCR for just that field (reExtractField) without discarding unsaved
          edits to any other field -- see handleReExtractField's comment for
          why this never calls router.refresh(). Line-item uncertain fields
          have no entry here at all (reExtractableUncertainFields already
          filters them out), matching reExtractField's own v1 scope. */}
      {reExtractableUncertainFields.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-orange-200 bg-orange-50/60 px-2 py-1.5 dark:border-orange-900 dark:bg-orange-950/30">
          <span className="text-xs text-muted-foreground">Re-extract a flagged field:</span>
          {reExtractableUncertainFields.map((f) => {
            const busy = reExtractingField === f.field
            return (
              <Button
                key={f.field}
                type="button"
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-2 text-xs"
                disabled={busy || formDisabled}
                onClick={() => void handleReExtractField(f.field)}
                title={`Re-run OCR for ${(UNCERTAIN_FIELD_LABEL[f.field] ?? f.field).toLowerCase()} only`}
              >
                <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
                {UNCERTAIN_FIELD_LABEL[f.field] ?? f.field.replace(/_/g, ' ')}
              </Button>
            )
          })}
        </div>
      ) : null}

      <div ref={paneContainerRef} className="flex min-h-0 min-w-0 flex-1">
        <div
          className="min-h-0 min-w-0 flex-shrink-0"
          style={{ width: paneMode === 'collapsed' ? COLLAPSED_PANE_WIDTH_PX : `${splitPercent}%` }}
        >
          <PdfViewer
            ref={pdfViewerRef}
            sourceDocumentId={detail.sourceDocumentId}
            documentExtractionId={detail.documentExtractionId}
            pageNumberStart={detail.pageNumberStart}
            initialPageOverride={initialPageOverride}
            pages={detail.pages}
            uncertainFields={detail.uncertainFields}
            collapsed={paneMode === 'collapsed'}
            onPageInfoChange={handlePdfPageInfoChange}
            billPageRanges={billPageRanges}
            onRequestBillSwitch={handleRequestBillSwitch}
          />
        </div>

        {paneMode === 'collapsed' ? (
          <div className="w-3 flex-shrink-0" />
        ) : (
          // Draggable divider (checklist 3.4): continuous, not limited to the
          // three preset stops -- \ snaps to a mode's canonical ratio, this
          // adjusts splitPercent to anything in between.
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize PDF and form panes"
            className="mx-1 w-1.5 flex-shrink-0 cursor-col-resize touch-none rounded bg-border hover:bg-primary/50"
            onPointerDown={handleDividerPointerDown}
            onPointerMove={handleDividerPointerMove}
            onPointerUp={handleDividerPointerUp}
          />
        )}

        <div className="min-h-0 min-w-0 flex-1">
          <ExtractionForm
            ref={formContainerRef}
            keymap={keymap}
            header={header}
            onHeaderChange={onHeaderChange}
            lineItems={lineItems}
            onLineItemChange={onLineItemChange}
            disabled={formDisabled}
            onFieldEnter={handleFieldEnter}
            vendorId={vendorId}
            vendorAutocompleteOpen={vendorAutocompleteOpen}
            onVendorAutocompleteOpenChange={setVendorAutocompleteOpen}
            onVendorSelect={handleVendorSelect}
            uncertainFields={detail.uncertainFields}
            editedFields={editedFields}
            validationErrors={validationErrors}
            invoiceDateWarning={invoiceDateWarning}
            onAddLineItem={handleAddLineItem}
            addingLineItem={addingLineItem}
            onReExtract={requestReExtract}
            onFlagException={() => setExceptionOpen(true)}
            pageNumberStart={detail.pageNumberStart}
            pageNumberEnd={detail.pageNumberEnd}
            currentPdfPage={pdfPageInfo.pageNumber}
            gstCharged={detail.gstCharged}
            onJumpToPage={onJumpToPage}
          />
        </div>
      </div>

      <TallyFooter lineItemSum={lineItemSum} documentTotal={documentTotal} entryAmount={detail.entryAmount} />

      <Dialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction?.kind === 're-extract'
                ? dirty
                  ? 'Discard unsaved corrections and re-extract?'
                  : 'Re-extract this document with Sonnet?'
                : 'Leave without saving?'}
            </DialogTitle>
            <DialogDescription>
              {confirmAction?.kind === 're-extract'
                ? dirty
                  ? 'Re-extracting with Sonnet rebuilds this form from a new OCR run. Your unsaved corrections on this document will be lost.'
                  : 'This runs a new Sonnet extraction on the whole document, which costs more than the original Haiku pass. Only do this if the current extraction is genuinely wrong.'
                : 'This document has unsaved corrections. Moving to another document discards them.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmAction(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmPendingAction}>
              {confirmAction?.kind === 're-extract' ? 'Re-extract' : 'Discard and continue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={vendorAliasPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setVendorAliasPrompt(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Record &lsquo;{vendorAliasPrompt?.rawName}&rsquo; as another spelling of {vendorAliasPrompt?.vendorDisplayName}?
            </DialogTitle>
            <DialogDescription>
              This only teaches future bills to match this vendor faster. The vendor name on this bill stays exactly as OCR read it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setVendorAliasPrompt(null)} disabled={confirmingVendorAlias}>
              No
            </Button>
            <Button type="button" onClick={handleConfirmVendorAlias} disabled={confirmingVendorAlias}>
              Yes, record it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShortcutsOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} keymap={keymap} />
      <ExceptionDialog
        open={exceptionOpen}
        onOpenChange={setExceptionOpen}
        sourceDocumentId={detail.sourceDocumentId}
        documentExtractionId={detail.documentExtractionId}
        entryId={detail.entryId}
        onFlagged={() => router.refresh()}
      />
      {detail.entryId !== null ? (
        <HubStatusDialog
          open={hubStatusOpen}
          onOpenChange={setHubStatusOpen}
          entryId={detail.entryId}
          currentCode={detail.hubStatusCode}
          options={detail.hubStatusOptions}
          onChanged={() => router.refresh()}
        />
      ) : null}
    </div>
  )
}
