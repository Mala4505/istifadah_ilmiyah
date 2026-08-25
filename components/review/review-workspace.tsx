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
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { normalizeUnit, normalizeVendorName } from '@/lib/normalize'
import {
  addLineItem,
  claimReviewDocument,
  confirmVendorAlias,
  reExtractField,
  saveEntryClassification,
  saveVerification,
  type ReExtractableHeaderField,
  type SaveVerificationInput,
  type VendorSearchResult,
} from '@/lib/actions/review'
import { type ReviewDocumentDetail } from '@/lib/review/types'
import { type Keymap, isSafeShortcutTarget, matchLineDigit, matchesBinding } from '@/lib/shortcuts/config'
import { PdfViewer, type PdfViewerHandle } from './pdf-viewer'
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

const HEADER_AMOUNT_FIELDS: (keyof HeaderFormState)[] = ['subtotal', 'taxAmount', 'totalAmount']

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

  const [header, setHeader] = useState<HeaderFormState>(() => buildHeaderState(detail))
  const [lineItems, setLineItems] = useState<LineItemFormState[]>(() => buildLineItemState(detail))
  const [vendorId, setVendorId] = useState<number | null>(detail.entryVendorId)
  const [vendorAutocompleteOpen, setVendorAutocompleteOpen] = useState(false)

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

  // Dirty tracking (D3/plan §2, checklist 1.5): the workspace remounts fresh
  // per document + extraction run (keyed in review/page.tsx), so capturing
  // the initial snapshot once at mount -- before any edits -- gives a stable
  // baseline to diff live state against for the rest of this document's
  // lifetime.
  const initialHeaderRef = useRef<HeaderFormState>(header)
  const initialLineItemsRef = useRef<LineItemFormState[]>(lineItems)
  const dirty = useMemo(
    () =>
      JSON.stringify(header) !== JSON.stringify(initialHeaderRef.current) ||
      JSON.stringify(lineItems) !== JSON.stringify(initialLineItemsRef.current),
    [header, lineItems]
  )

  // L3 (plan §11, checklist 3.3): "edited from OCR" is a different question
  // from `dirty` above -- dirty compares against this mount's initial
  // snapshot (which may already include a previous reviewer's corrections);
  // this compares the live value against `detail.header`/`detail.lineItems`'
  // `.ocr` baseline, so a field corrected in an earlier pass and left
  // untouched now still reads as edited. Feeds ExtractionForm's blue ring
  // and drives L2's per-row auto-expand.
  const editedFields = useMemo<EditedFieldSets>(() => {
    const headerSet = new Set<keyof HeaderFormState>()
    for (const key of Object.keys(header) as (keyof HeaderFormState)[]) {
      if (header[key].trim() !== numToStr(detail.header[key].ocr).trim()) headerSet.add(key)
    }
    const lineItemsMap = new Map<number, Set<string>>()
    for (const li of lineItems) {
      const baseline = detail.lineItems.find((d) => d.id === li.id)
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
    return { header: headerSet, lineItems: lineItemsMap }
  }, [header, lineItems, detail])

  // 5.15 (checklist Phase 5, plan §13): every amount-shaped field that
  // buildSavePayload below runs through parseNum, checked with
  // isUnparseableAmount so a genuinely blank field (parses to null, no error)
  // and garbage text (also parses to null, but should block save) are told
  // apart. Shaped exactly like editedFields above -- header Set + line-items
  // Map keyed by lineOrder -- so ExtractionForm can reuse the same lookup
  // pattern for the red ring.
  const validationErrors = useMemo<ValidationErrorSets>(() => {
    const headerSet = new Set<keyof HeaderFormState>()
    for (const key of HEADER_AMOUNT_FIELDS) {
      if (isUnparseableAmount(header[key])) headerSet.add(key)
    }
    const lineItemsMap = new Map<number, Set<string>>()
    for (const li of lineItems) {
      const errorKeys = new Set<string>()
      if (isUnparseableAmount(li.quantity)) errorKeys.add('quantity')
      if (isUnparseableAmount(li.rate)) errorKeys.add('rate')
      if (isUnparseableAmount(li.amount)) errorKeys.add('amount')
      if (errorKeys.size > 0) lineItemsMap.set(li.lineOrder, errorKeys)
    }
    return { header: headerSet, lineItems: lineItemsMap }
  }, [header, lineItems])

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
    const raw = header.invoiceDate.trim()
    if (!raw) return null
    return raw > todayLocalDateString() ? 'This invoice date is in the future.' : null
  }, [header.invoiceDate])

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

  // MatchStrip's attach/change actions call router.refresh() rather than
  // navigating (no key change), so this component doesn't remount when
  // `detail.entryId` changes mid-session -- re-seed explicitly whenever the
  // matched entry (or its classification) changes underneath us, otherwise
  // these two Selects would keep showing whatever was true for the
  // previously-attached (or no) entry.
  useEffect(() => {
    setAdminHeadId(detail.entryAdminHeadId ? String(detail.entryAdminHeadId) : NONE)
    setZoneId(detail.entryZoneId ? String(detail.entryZoneId) : NONE)
  }, [detail.entryId, detail.entryAdminHeadId, detail.entryZoneId])

  const [claimState, setClaimState] = useState<'checking' | 'mine' | 'blocked'>('checking')
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

  // Claim/lock (§7): attempt to claim on mount; surface a takeover prompt
  // instead of silently overwriting someone else's active claim.
  useEffect(() => {
    let cancelled = false
    setClaimState('checking')
    void claimReviewDocument(detail.sourceDocumentId).then((result) => {
      if (cancelled) return
      if (result.ok) {
        setClaimState('mine')
        return
      }
      if ('needsTakeover' in result && result.needsTakeover) {
        setClaimState('blocked')
        setClaimInfo({ displayName: result.claimedByDisplayName, claimedAt: result.claimedAt })
        return
      }
      // Transient error (network, etc.) -- fail open rather than locking the
      // reviewer out of a document they can otherwise see.
      toastError(result.error, { context: 'review-workspace' })
      setClaimState('mine')
    })
    return () => {
      cancelled = true
    }
  }, [detail.sourceDocumentId])

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

  function goToDocument(id: number | null, page?: number | null) {
    if (id === null) {
      toast.info('No more documents in that direction.')
      return
    }
    router.push(`/review?id=${id}${page ? `&page=${page}` : ''}`)
  }

  // Guarded entry point for Prev/Next/PgUp/PgDn (checklist 1.8): today
  // `goToDocument` discards unsaved edits the instant the target component
  // remounts. Route every navigation call site through this instead so a
  // dirty form always confirms first. `page` carries a specific target page
  // through the confirm dialog too -- used by handleRequestBillSwitch below
  // when a reviewer clicks a sibling bill's page in the thumbnail rail.
  function requestGoToDocument(id: number | null, page?: number | null) {
    if (id === null) {
      toast.info('No more documents in that direction.')
      return
    }
    if (dirty) {
      setConfirmAction({ kind: 'navigate', targetId: id, targetPage: page ?? null })
      return
    }
    goToDocument(id, page)
  }

  // PdfViewer's thumbnail rail shows every page of the shared source PDF,
  // including sibling bills' own pages -- clicking one that isn't in this
  // bill's own page range should switch the whole workspace (OCR form
  // included) to whichever bill actually owns that page, landing on it
  // directly, rather than just scrolling the canvas to a page whose data
  // isn't the one on screen.
  function handleRequestBillSwitch(targetDocumentExtractionId: number, pageNumber: number) {
    requestGoToDocument(targetDocumentExtractionId, pageNumber)
  }

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
        })
        if (!classificationResult.ok) {
          toastError(classificationResult.error, {
            title: 'Saved, but admin head/zone could not be saved.',
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
  // ReviewDocumentDetail and, because currentExtractionRunId is part of this
  // workspace's React key, remount the whole form and discard any unsaved
  // edits to every OTHER field -- exactly the bug this feature exists to
  // avoid. Instead this patches only that one key of local `header` state,
  // leaving everything else (including that same field's own dirty/edited
  // status relative to the ORIGINAL ocr baseline) untouched.
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
      setHeader((h) => ({ ...h, [headerKey]: numToStr(result.newValue) }))
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
        'This document is not matched to an entry yet, so there is no Hub status to set (see the document inbox, Day 3).'
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
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        handleSave()
        return
      }

      if (!isSafeShortcutTarget(document.activeElement)) return

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

      // Configurable commands, gated by the master enable/disable (plan
      // §2.1). Each trigger is looked up in the resolved keymap rather than
      // hardcoded, so a staff member's remaps take effect immediately.
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
      const lineIndex = matchLineDigit(e, keymap.jumpToLineDigit)
      if (lineIndex !== null) {
        e.preventDefault()
        const target = formContainerRef.current?.querySelector<HTMLElement>(`[data-line-jump-index="${lineIndex}"]`)
        target?.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // No dependency array: re-registers every render so the closure always
    // sees current state/handlers (header, lineItems, claimState, etc.) --
    // cheap at this component's render frequency and simpler than threading
    // everything through refs just to satisfy exhaustive-deps.
  })

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

  const lineItemSum = lineItems.length > 0 ? lineItems.reduce((sum, li) => sum + (parseNum(li.amount) ?? 0), 0) : null
  const documentTotal = parseNum(header.totalAmount)

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
  const stage3Done = stage2Done && adminHeadId !== NONE && zoneId !== NONE
  const verifyStatus: StageStatus = stage2Done ? 'done' : 'current'
  const connectStatus: StageStatus = stage2Done ? 'done' : 'current'
  const classifyStatus: StageStatus = !stage2Done ? 'blocked' : stage3Done ? 'done' : 'current'

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
          Flag exception (E)
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
              {reExtracting ? 'Re-extracting…' : 'Re-extract with Sonnet (Alt+R)'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={openHubStatus} disabled={!detail.canSetHubStatus || formDisabled}>
              Hub status (S)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setShortcutsOpen(true)}>Shortcuts (?)</DropdownMenuItem>
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
            reviewer to act. Everything else in this row is plain text. */}
        {detail.openExceptions.map((ex) => (
          <span
            key={ex.id}
            className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
            title={ex.description ?? undefined}
          >
            {ex.severity.toUpperCase()} · {ex.exceptionType.replace(/_/g, ' ')}
          </span>
        ))}

        {toolbarInfoText ? <span className="ml-auto text-xs text-muted-foreground">{toolbarInfoText}</span> : null}
      </div>

      {/* Plan §4: one card, one row, three segments (Verify/Connect/Classify)
          -- replaces StageProgress's chip row, the standalone MatchStrip
          card, and the standalone bottom Classify bar that used to sit below
          TallyFooter. Every value/handler here is lifted from this
          component's own state; ReviewStatusLine owns none of it. */}
      <ReviewStatusLine
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
        entryVendorDisplayName={detail.entryVendorDisplayName}
        entryAmount={detail.entryAmount}
        liveTotalAmount={documentTotal}
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
            billPageRanges={detail.siblingBills.map((b) => ({
              documentExtractionId: b.documentExtractionId,
              pageNumberStart: b.pageNumberStart,
              pageNumberEnd: b.pageNumberEnd,
            }))}
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
            header={header}
            onHeaderChange={(field, value) => setHeader((h) => ({ ...h, [field]: value }))}
            lineItems={lineItems}
            onLineItemChange={(id, field, value) =>
              setLineItems((items) => items.map((li) => (li.id === id ? { ...li, [field]: value } : li)))
            }
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
            onJumpToPage={(pageNumber) => {
              pdfViewerRef.current?.goToPage(pageNumber)
              // Checklist 3.10: a collapsed spine can't actually show the
              // page being jumped to -- expand so the reviewer can see it.
              if (paneMode === 'collapsed') {
                setPaneMode('split')
                setSplitPercent(PANE_MODE_DEFAULT_SPLIT.split)
              }
            }}
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
