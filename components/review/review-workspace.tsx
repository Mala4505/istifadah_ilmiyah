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

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { normalizeUnit } from '@/lib/normalize'
import {
  claimReviewDocument,
  saveVerification,
  type SaveVerificationInput,
  type VendorSearchResult,
} from '@/lib/actions/review'
import { confidenceTint, type ReviewDocumentDetail } from '@/lib/review/types'
import { PdfViewer, type PdfViewerHandle } from './pdf-viewer'
import { ExtractionForm, type HeaderFormState, type LineItemFormState } from './extraction-form'
import { TallyFooter } from './tally-footer'
import { ClaimBanner } from './claim-banner'
import { ShortcutsOverlay } from './shortcuts-overlay'
import { ExceptionDialog } from './exception-dialog'
import { HubStatusDialog } from './hub-status-dialog'

function numToStr(v: string | number | null): string {
  return v === null || v === undefined ? '' : String(v)
}

function parseNum(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function buildHeaderState(detail: ReviewDocumentDetail): HeaderFormState {
  const h = detail.header
  return {
    vendorName: numToStr(h.vendorName.verified ?? h.vendorName.ocr),
    vendorGstin: numToStr(h.vendorGstin.verified ?? h.vendorGstin.ocr),
    vendorPhone: numToStr(h.vendorPhone.verified ?? h.vendorPhone.ocr),
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
    description: numToStr(li.description.verified ?? li.description.ocr),
    hsnSacCode: numToStr(li.hsnSacCode.verified ?? li.hsnSacCode.ocr),
    quantity: numToStr(li.quantity.verified ?? li.quantity.ocr),
    quantityRawText: numToStr(li.quantityRawText.verified ?? li.quantityRawText.ocr),
    unit: numToStr(li.unit.verified ?? li.unit.ocr),
    unitNormalized: li.unitNormalized ?? '',
    listRate: numToStr(li.listRate.verified ?? li.listRate.ocr),
    discountPct: numToStr(li.discountPct.verified ?? li.discountPct.ocr),
    discountNote: numToStr(li.discountNote.verified ?? li.discountNote.ocr),
    netRate: numToStr(li.netRate.verified ?? li.netRate.ocr),
    lineAmount: numToStr(li.lineAmount.verified ?? li.lineAmount.ocr),
  }))
}

export function ReviewWorkspace({
  detail,
  prevId,
  nextId,
}: {
  detail: ReviewDocumentDetail
  queue: { sourceDocumentId: number }[]
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

  const [claimState, setClaimState] = useState<'checking' | 'mine' | 'blocked'>('checking')
  const [claimInfo, setClaimInfo] = useState<{ displayName: string; claimedAt: string } | null>(null)
  const [takingOver, setTakingOver] = useState(false)

  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [exceptionOpen, setExceptionOpen] = useState(false)
  const [hubStatusOpen, setHubStatusOpen] = useState(false)
  const [reExtracting, setReExtracting] = useState(false)

  const [isSaving, startSaving] = useTransition()

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
      toast.error(result.error)
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

  function handleTakeOver() {
    setTakingOver(true)
    void claimReviewDocument(detail.sourceDocumentId, { takeover: true }).then((result) => {
      setTakingOver(false)
      if (result.ok) {
        setClaimState('mine')
        toast.success('Claim taken over.')
      } else if ('error' in result) {
        toast.error(result.error)
      }
    })
  }

  function buildSavePayload(): SaveVerificationInput {
    return {
      sourceDocumentId: detail.sourceDocumentId,
      header: {
        vendor_name: header.vendorName.trim() || null,
        vendor_gstin: header.vendorGstin.trim() || null,
        vendor_phone: header.vendorPhone.trim() || null,
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
          list_rate: parseNum(li.listRate),
          discount_pct: parseNum(li.discountPct),
          discount_note: li.discountNote.trim() || null,
          net_rate: parseNum(li.netRate),
          line_amount: parseNum(li.lineAmount),
        }
      }),
      vendorId,
    }
  }

  function handleSave() {
    if (claimState === 'blocked') {
      toast.error('Take over the claim before saving.')
      return
    }
    startSaving(async () => {
      const result = await saveVerification(buildSavePayload())
      if (!result.ok) {
        toast.error(result.error)
        return
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
        toast.error(json.error ?? 'Re-extraction failed.')
        return
      }
      toast.success(`Re-extracted with ${json.model} -- ${json.lineItemCount} line item(s).`)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setReExtracting(false)
    }
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
        goToDocument(nextId)
        return
      }
      if (e.key === 'PageUp') {
        e.preventDefault()
        goToDocument(prevId)
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
      if (e.key.toLowerCase() === 'e') {
        e.preventDefault()
        setExceptionOpen(true)
        return
      }
      if (e.key.toLowerCase() === 'r') {
        e.preventDefault()
        void handleReExtract()
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

  const tint = confidenceTint(detail.extractionConfidence)
  const lineItemSum = lineItems.length > 0 ? lineItems.reduce((sum, li) => sum + (parseNum(li.lineAmount) ?? 0), 0) : null
  const documentTotal = parseNum(header.totalAmount)
  const formDisabled = claimState === 'blocked'

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
        <Button type="button" size="sm" variant="outline" onClick={() => void handleReExtract()} disabled={reExtracting}>
          {reExtracting ? 'Re-extracting…' : 'Re-extract (R)'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={openHubStatus}
          disabled={!detail.canSetHubStatus || formDisabled}
        >
          Hub status (S)
        </Button>
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => setShortcutsOpen(true)}>
          Shortcuts (?)
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={prevId === null} onClick={() => goToDocument(prevId)}>
          ← Prev doc (PgUp)
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={nextId === null} onClick={() => goToDocument(nextId)}>
          Next doc (PgDn) →
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <PdfViewer ref={pdfViewerRef} sourceDocumentId={detail.sourceDocumentId} />
        <ExtractionForm
          ref={formContainerRef}
          header={header}
          onHeaderChange={(field, value) => setHeader((h) => ({ ...h, [field]: value }))}
          lineItems={lineItems}
          onLineItemChange={(id, field, value) =>
            setLineItems((items) => items.map((li) => (li.id === id ? { ...li, [field]: value } : li)))
          }
          tint={tint}
          disabled={formDisabled}
          onFieldEnter={handleFieldEnter}
          vendorId={vendorId}
          vendorAutocompleteOpen={vendorAutocompleteOpen}
          onVendorAutocompleteOpenChange={setVendorAutocompleteOpen}
          onVendorSelect={handleVendorSelect}
        />
      </div>

      <TallyFooter lineItemSum={lineItemSum} documentTotal={documentTotal} entryAmount={detail.entryAmount} />

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
