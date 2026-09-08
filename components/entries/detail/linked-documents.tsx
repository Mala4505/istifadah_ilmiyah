'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { FileText, ExternalLink } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { detachDocumentFromEntry, getDocumentPreviewUrl } from '@/lib/actions/documents'
import { BillViewModal } from '@/components/entries/detail/bill-view-modal'
import { formatINR, formatDate } from '@/lib/reports/format'
import { cn } from '@/lib/utils'

export interface LinkedDocumentView {
  id: number
  originalFilename: string
  uploadedAt: string
  pageCount: number | null
  vendorNameOcr: string | null
  invoiceNumberOcr: string | null
  totalAmountOcr: number | null
  invoiceDateOcr: string | null
  /** How many OTHER entries this bill also covers (0 = this entry only). */
  alsoCoversOtherEntries: number
}

/**
 * Entry-grain variance from `v_entry_bill_variance` (Phase 2), resolved on the
 * server so the footer isn't doing client-side arithmetic over partial data.
 */
export interface LinkedDocumentsVariance {
  entryAmount: number
  billedTotal: number
  /** entryAmount - billedTotal, signed. */
  varianceAmount: number
  withinTolerance: boolean
  billCount: number
  verifiedBillCount: number
}

/**
 * What used to be a bare count ("Documents: 2 attached", no way to see which
 * two or why) — now the actual linked PDFs, with the OCR'd values that made
 * the match so it's visible AT A GLANCE why this file is attached to this
 * entry, plus a way to view the original and undo a wrong attach.
 */
export function LinkedDocuments({
  entryId,
  documents,
  entryAmount,
  variance,
}: {
  entryId: number
  documents: LinkedDocumentView[]
  entryAmount: number | null
  variance: LinkedDocumentsVariance | null
}) {
  const [pendingId, setPendingId] = useState<number | null>(null)
  const [rows, setRows] = useState(documents)

  // §3.2 (docs/pre-deploy-findings-and-plan.md) — the footer totals now come
  // from `v_entry_bill_variance` via the RSC (`variance` prop), not from
  // client-side arithmetic over the OCR'd per-bill totals. That fixes the old
  // bug where a ₹0.01 rounding gap rendered the difference in red: it is red
  // only when the gap is outside `tallyWithinTolerance`.
  //
  // Detaching a doc below updates `rows` optimistically but does NOT refetch
  // `variance` — the footer figures can be briefly stale after a detach until
  // a full navigation / revalidation refreshes the server data.

  function handlePreview(documentId: number) {
    void (async () => {
      const result = await getDocumentPreviewUrl(documentId)
      if (!result.ok) {
        toastError(result.error, { context: 'linked-documents' })
        return
      }
      window.open(result.url, '_blank', 'noopener,noreferrer')
    })()
  }

  function handleDetach(documentId: number) {
    setPendingId(documentId)
    void (async () => {
      const result = await detachDocumentFromEntry(documentId, entryId)
      setPendingId(null)
      if (!result.ok) {
        toastError(result.error, { context: 'linked-documents' })
        return
      }
      toast.success('Document detached — it is back in the inbox.')
      setRows((current) => current.filter((r) => r.id !== documentId))
    })()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Documents</CardTitle>
        <CardDescription>
          {rows.length === 0
            ? 'No PDF is attached to this entry yet.'
            : `${rows.length} attached — matched by vendor, amount and date.`}
        </CardDescription>
      </CardHeader>
      {rows.length > 0 && (
        <CardContent className="flex flex-col gap-2">
          {rows.map((doc) => (
            <div
              key={doc.id}
              className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-start gap-2">
                <FileText className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{doc.originalFilename}</p>
                  <p className="text-xs text-muted-foreground">
                    Uploaded {formatDate(doc.uploadedAt)}
                    {doc.pageCount ? ` · ${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}` : ''}
                  </p>
                  {(doc.vendorNameOcr || doc.totalAmountOcr || doc.invoiceNumberOcr) && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Read from the PDF: {doc.vendorNameOcr ?? '—'}
                      {doc.invoiceNumberOcr ? ` · Inv ${doc.invoiceNumberOcr}` : ''}
                      {doc.totalAmountOcr !== null ? ` · ${formatINR(doc.totalAmountOcr)}` : ''}
                      {doc.invoiceDateOcr ? ` · ${formatDate(doc.invoiceDateOcr)}` : ''}
                    </p>
                  )}
                  {doc.alsoCoversOtherEntries > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Also covers {doc.alsoCoversOtherEntries} other{' '}
                      {doc.alsoCoversOtherEntries === 1 ? 'entry' : 'entries'}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2 self-end sm:self-auto">
                <BillViewModal documentId={doc.id} entryId={entryId} />
                <Button variant="outline" size="sm" onClick={() => handlePreview(doc.id)}>
                  PDF
                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pendingId === doc.id}
                  onClick={() => handleDetach(doc.id)}
                >
                  {pendingId === doc.id ? 'Detaching…' : 'Detach'}
                </Button>
              </div>
            </div>
          ))}

          <div className="border-t border-border pt-3 text-sm">
            {variance === null ? (
              <p className="text-muted-foreground">No bill linked yet.</p>
            ) : (
              <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-4">
                <span className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span>
                    <span className="text-muted-foreground">Entry amount: </span>
                    <span className="font-medium tabular-nums">
                      {formatINR(variance.entryAmount ?? entryAmount)}
                    </span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">Billed (sum of linked bills): </span>
                    <span className="font-medium tabular-nums">{formatINR(variance.billedTotal)}</span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">Difference: </span>
                    <span
                      className={cn(
                        'font-medium tabular-nums',
                        !variance.withinTolerance && 'text-destructive'
                      )}
                    >
                      {formatINR(variance.varianceAmount)}
                    </span>
                  </span>
                </span>
                <span
                  className={cn(
                    'text-xs font-medium',
                    variance.withinTolerance
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-destructive'
                  )}
                >
                  {variance.withinTolerance ? 'Within tolerance' : 'Outside tolerance'}
                </span>
              </div>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  )
}
