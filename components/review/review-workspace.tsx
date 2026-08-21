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

import { useEffect, useMemo, useRef, useState, useTransition, type PointerEvent as ReactPointerEvent } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { normalizeUnit } from '@/lib/normalize'
import {
  addLineItem,
  claimReviewDocument,
  saveEntryClassification,
  saveVerification,
  type SaveVerificationInput,
  type VendorSearchResult,
} from '@/lib/actions/review'
import { confidenceTint, type ConfidenceTint, type ReviewDocumentDetail } from '@/lib/review/types'
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
import { MatchStrip } from './match-strip'
import { StageProgress, type StageStatus } from './stage-progress'

const NONE = '__none__'

// L3 (plan §11): confidence used to tint every field in the form; it now
// lives only here, as one toolbar badge, colour-matched to confidenceTint's
// same 0.9/0.7 thresholds so the badge and the (removed) field tint would
// never have disagreed.
const CONFIDENCE_BADGE_CLASSES: Record<ConfidenceTint, string> = {
  green: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  amber: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  red: 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200',
  none: 'border-border bg-background text-muted-foreground',
}

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

function buildHeaderState(detail: ReviewDocumentDetail): HeaderFormState {
  const h = detail.header
  return {
    vendorName: numToStr(h.vendorName.verified ?? h.vendorName.ocr),
    vendorGstin: numToStr(h.vendorGstin.verified ?? h.vendorGstin.ocr),
    vendorPhone: numToStr(h.vendorPhone.verified ?? h.vendorPhone.ocr),
    vendorEmail: numToStr(h.vendorEmail.verified ?? h.vendorEmail.ocr),
    vendorAddress: numToStr(h.vendorAddress.verified ?? h.vendorAddress.ocr),
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
}: {
  detail: ReviewDocumentDetail
  queue: { documentExtractionId: number }[]
  currentIndex: number
  prevId: number | null
  nextId: number | null
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
    { kind: 're-extract' } | { kind: 'navigate'; targetId: number } | null
  >(null)

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

  function goToDocument(id: number | null) {
    if (id === null) {
      toast.info('No more documents in that direction.')
      return
    }
    router.push(`/review?id=${id}`)
  }

  // Guarded entry point for Prev/Next/PgUp/PgDn (checklist 1.8): today
  // `goToDocument` discards unsaved edits the instant the target component
  // remounts. Route every navigation call site through this instead so a
  // dirty form always confirms first.
  function requestGoToDocument(id: number | null) {
    if (id === null) {
      toast.info('No more documents in that direction.')
      return
    }
    if (dirty) {
      setConfirmAction({ kind: 'navigate', targetId: id })
      return
    }
    goToDocument(id)
  }

  // Guarded entry point for re-extract (checklist 1.6): confirms first when
  // there are unsaved edits that the new extraction run would silently wipe
  // out on remount.
  function requestReExtract() {
    if (dirty) {
      setConfirmAction({ kind: 're-extract' })
      return
    }
    void handleReExtract()
  }

  function confirmPendingAction() {
    if (!confirmAction) return
    if (confirmAction.kind === 're-extract') {
      void handleReExtract()
    } else {
      goToDocument(confirmAction.targetId)
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
      if (nextId !== null) router.push(`/review?id=${nextId}`)
      else router.push('/review')
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
    setVendorId(vendor.id)
    setHeader((h) => ({ ...h, vendorName: vendor.displayName, vendorGstin: vendor.gstin ?? h.vendorGstin }))
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

  // Global keyboard contract (§7). Digits/arrows/PageUp/PageDown/E/R/S//
  // only act outside a focused text field -- typing amounts and notes is
  // never intercepted. Cmd/Ctrl-Enter saves everywhere, including inside a
  // field.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        handleSave()
        return
      }

      const active = document.activeElement as HTMLElement | null
      const isEditable =
        !!active &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) ||
          active.isContentEditable ||
          active.getAttribute('role') === 'combobox')
      if (isEditable) return

      if (e.key === '?') {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
        return
      }
      // Document navigation: PageDown/PageUp (§7 keyboard contract, remapped
      // from J/K so the arrow keys below are free for page turning within
      // the current document -- the two operations reviewers do most, split
      // onto two adjacent physical keys instead of one.
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
      // PDF pane mode (L1, checklist 3.5): Split -> Collapsed -> Document -> Split.
      if (e.key === '\\') {
        e.preventDefault()
        cyclePaneMode()
        return
      }
      if (e.key.toLowerCase() === 'e') {
        e.preventDefault()
        setExceptionOpen(true)
        return
      }
      // Re-extract moved off the bare letter (D3, checklist 1.6): this
      // forces a new Sonnet run and, via review/page.tsx's run-id key,
      // remounts the whole workspace from the database -- previously a
      // single unmodified `r` silently discarded every unsaved correction.
      // Shift+R plus a confirm-when-dirty gate makes that a deliberate
      // choice instead of a typo.
      if (e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        requestReExtract()
        return
      }
      if (e.key.toLowerCase() === 's') {
        e.preventDefault()
        openHubStatus()
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        setVendorAutocompleteOpen(true)
        return
      }
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault()
        document.getElementById('stage3-zone-select')?.focus()
        return
      }
      if (e.key.toLowerCase() === 'h') {
        e.preventDefault()
        document.getElementById('stage3-admin-head-select')?.focus()
        return
      }
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const target = formContainerRef.current?.querySelector<HTMLElement>(`[data-line-jump-index="${e.key}"]`)
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

  const tint = confidenceTint(detail.extractionConfidence)
  const lineItemSum = lineItems.length > 0 ? lineItems.reduce((sum, li) => sum + (parseNum(li.amount) ?? 0), 0) : null
  const documentTotal = parseNum(header.totalAmount)
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
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <ClaimBanner
        status={claimState}
        claimedByDisplayName={claimInfo?.displayName ?? null}
        claimedAt={claimInfo?.claimedAt ?? null}
        onTakeOver={handleTakeOver}
        isPending={takingOver}
      />

      {detail.openExceptions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {detail.openExceptions.map((ex) => (
            <span
              key={ex.id}
              className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
            >
              {ex.severity.toUpperCase()} · {ex.exceptionType.replace(/_/g, ' ')}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
        <Button type="button" size="sm" onClick={handleSave} disabled={isSaving || formDisabled}>
          {isSaving ? 'Saving…' : 'Save (Ctrl/Cmd+Enter)'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setExceptionOpen(true)} disabled={formDisabled}>
          Flag exception (E)
        </Button>
        {/* Plan §3: Re-extract/Hub status are deliberate, occasional
            overrides -- moved behind "More" so they stop competing for
            attention with Save/Flag on every ordinary bill. Handlers,
            disabled conditions and labels below are unchanged from before. */}
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
              {reExtracting ? 'Re-extracting…' : 'Re-extract with Sonnet (Shift+R)'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={openHubStatus} disabled={!detail.canSetHubStatus || formDisabled}>
              Hub status (S)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => setShortcutsOpen(true)}>
          Shortcuts (?)
        </Button>
        {detail.extractionConfidence !== null || detail.model || detail.legibility ? (
          <span
            className={`rounded-full border px-2 py-0.5 text-xs ${CONFIDENCE_BADGE_CLASSES[tint]}`}
          >
            {detail.extractionConfidence !== null ? `${Math.round(detail.extractionConfidence * 100)}% confidence` : 'Confidence unknown'}
            {detail.model ? ` · ${detail.model}` : ''}
            {detail.legibility ? ` · ${detail.legibility}` : ''}
          </span>
        ) : null}
        {detail.uncertainFields.length > 0 ? (
          <span className="flex items-center gap-1 rounded-full border border-orange-300 bg-orange-50 px-2 py-0.5 text-xs text-orange-900 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-5 px-1 text-orange-900 hover:bg-orange-100 dark:text-orange-200 dark:hover:bg-orange-900"
              aria-label="Previous flagged field"
              onClick={() => stepUncertainField(-1)}
            >
              ‹
            </Button>
            {uncertainStepIndex !== null ? uncertainStepIndex + 1 : '—'} of {detail.uncertainFields.length} to check
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-5 px-1 text-orange-900 hover:bg-orange-100 dark:text-orange-200 dark:hover:bg-orange-900"
              aria-label="Next flagged field"
              onClick={() => stepUncertainField(1)}
            >
              ›
            </Button>
          </span>
        ) : null}
        {/* 5.17: informational only, unlike the uncertain-fields chip above --
            editedFields already exists (1.5/L3's blue ring), this just totals
            it up. No stepper: there's nowhere useful to jump to that the blue
            rings on the form don't already show at a glance. */}
        {editedFieldCount > 0 ? (
          <span className="rounded-full border border-blue-300 bg-blue-50 px-2 py-0.5 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
            {editedFieldCount} changed from OCR
          </span>
        ) : null}
        {detail.billCount > 1 ? (
          <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Bill {detail.billIndex + 1} of {detail.billCount} in this PDF
          </span>
        ) : null}
      </div>

      {/* Plan §2: one card, three adjacent groups (Bill / Page / This PDF) --
          replaces the toolbar's Prev/Next-doc buttons, pdf-viewer.tsx's own
          page-nav row, and the sibling-bill row that used to live paired
          with StageProgress below. */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
        <span className="text-xs text-muted-foreground">
          Document {currentIndex + 1} of {queue.length}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={prevId === null}
          onClick={() => requestGoToDocument(prevId)}
        >
          ← Prev doc (PgUp)
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={nextId === null}
          onClick={() => requestGoToDocument(nextId)}
        >
          Next doc (PgDn) →
        </Button>

        <div className="h-4 w-px bg-border" />

        <span className="text-xs text-muted-foreground">
          {pdfPageInfo.numPages > 0 ? `Page ${pdfPageInfo.pageNumber} / ${pdfPageInfo.numPages}` : '—'}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pdfPageInfo.pageNumber <= 1}
          onClick={() => pdfViewerRef.current?.prevPage()}
        >
          ← Prev page
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pdfPageInfo.pageNumber >= pdfPageInfo.numPages}
          onClick={() => pdfViewerRef.current?.nextPage()}
        >
          Next page →
        </Button>

        {detail.billCount > 1 ? (
          <>
            <div className="h-4 w-px bg-border" />
            <span className="text-xs text-muted-foreground">Bills in this PDF:</span>
            {detail.siblingBills.map((bill) => (
              <button
                key={bill.documentExtractionId}
                type="button"
                onClick={() => requestGoToDocument(bill.documentExtractionId)}
                title={bill.matched ? 'Matched' : 'Unmatched'}
                className={`flex h-6 min-w-6 items-center justify-center rounded-full border px-1.5 text-xs ${
                  bill.documentExtractionId === detail.documentExtractionId
                    ? 'border-primary bg-primary text-primary-foreground'
                    : bill.matched
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
                      : 'border-border bg-background text-muted-foreground'
                }`}
              >
                {bill.billIndex + 1}
              </button>
            ))}
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <StageProgress verify={verifyStatus} connect={connectStatus} classify={classifyStatus} />
      </div>

      <MatchStrip
        documentExtractionId={detail.documentExtractionId}
        sourceDocumentId={detail.sourceDocumentId}
        entryId={detail.entryId}
        entryUbblNumber={detail.entryUbblNumber}
        entryVendorDisplayName={detail.entryVendorDisplayName}
        entryAmount={detail.entryAmount}
        liveTotalAmount={documentTotal}
        matchCandidates={detail.matchCandidates}
        onChanged={() => router.refresh()}
      />

      <div ref={paneContainerRef} className="flex min-h-0 flex-1">
        <div
          className="min-h-0 min-w-0 flex-shrink-0"
          style={{ width: paneMode === 'collapsed' ? COLLAPSED_PANE_WIDTH_PX : `${splitPercent}%` }}
        >
          <PdfViewer
            ref={pdfViewerRef}
            sourceDocumentId={detail.sourceDocumentId}
            pages={detail.pages}
            uncertainFields={detail.uncertainFields}
            collapsed={paneMode === 'collapsed'}
            onPageInfoChange={(pageNumber, numPages) => setPdfPageInfo({ pageNumber, numPages })}
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

      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-background px-2 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">3 Classify</span>
        {!stage2Done ? (
          <span className="text-xs text-muted-foreground">Match this bill to an entry first</span>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="stage3-admin-head-select" className="text-xs">
                Admin head (H)
              </Label>
              <Select value={adminHeadId} onValueChange={setAdminHeadId}>
                <SelectTrigger id="stage3-admin-head-select" className="h-8 w-56 text-xs">
                  <SelectValue placeholder="Not set" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not set</SelectItem>
                  {detail.adminHeadOptions.map((h) => (
                    <SelectItem key={h.id} value={String(h.id)}>
                      {h.head_number}. {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="stage3-zone-select" className="text-xs">
                Zone (Z)
              </Label>
              <Select value={zoneId} onValueChange={setZoneId}>
                <SelectTrigger id="stage3-zone-select" className="h-8 w-56 text-xs">
                  <SelectValue placeholder="Not set" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not set</SelectItem>
                  {detail.zoneOptions.map((z) => (
                    <SelectItem key={z.id} value={String(z.id)}>
                      {z.zone_number}. {z.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <span className="text-xs text-muted-foreground">Saved with the next Save (Ctrl/Cmd+Enter)</span>
          </>
        )}
      </div>

      <Dialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction?.kind === 're-extract' ? 'Discard unsaved corrections?' : 'Leave without saving?'}
            </DialogTitle>
            <DialogDescription>
              {confirmAction?.kind === 're-extract'
                ? 'Re-extracting with Sonnet rebuilds this form from a new OCR run. Your unsaved corrections on this document will be lost.'
                : 'This document has unsaved corrections. Moving to another document discards them.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmAction(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmPendingAction}>
              {confirmAction?.kind === 're-extract' ? 'Re-extract anyway' : 'Discard and continue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShortcutsOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
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
