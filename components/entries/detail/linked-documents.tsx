'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { FileText, ExternalLink } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { detachDocumentFromEntry, getDocumentPreviewUrl } from '@/lib/actions/documents'
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
}: {
  entryId: number
  documents: LinkedDocumentView[]
  entryAmount: number | null
}) {
  const [pendingId, setPendingId] = useState<number | null>(null)
  const [rows, setRows] = useState(documents)

  // §3.2 (docs/pre-deploy-findings-and-plan.md) — this card used to list each
  // bill's OCR'd total with no arithmetic tying them to the entry's own
  // amount, so the tally had to be done by eye. Every number here is already
  // on the page; this just adds them up. Bills with no OCR'd total (still in
  // review, or extraction failed) are excluded from the sum but counted
  // separately so the footer doesn't silently imply a false total.
  const billsWithTotal = rows.filter((d) => d.totalAmountOcr !== null)
  const sumOfTotals = billsWithTotal.reduce((sum, d) => sum + (d.totalAmountOcr ?? 0), 0)
  const difference = entryAmount !== null ? entryAmount - sumOfTotals : null

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
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2 self-end sm:self-auto">
                <Button variant="outline" size="sm" onClick={() => handlePreview(doc.id)}>
                  View
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

          <div className="flex flex-col gap-1 border-t border-border pt-3 text-sm sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-4">
            <span className="text-muted-foreground">
              {rows.length} bill{rows.length === 1 ? '' : 's'} attached
              {billsWithTotal.length !== rows.length && (
                <> · {billsWithTotal.length} of {rows.length} with a read total</>
              )}
            </span>
            <span className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span>
                <span className="text-muted-foreground">Sum of bills: </span>
                <span className="font-medium tabular-nums">{formatINR(sumOfTotals)}</span>
              </span>
              <span>
                <span className="text-muted-foreground">Entry amount: </span>
                <span className="font-medium tabular-nums">{formatINR(entryAmount)}</span>
              </span>
              <span>
                <span className="text-muted-foreground">Difference: </span>
                <span
                  className={cn(
                    'font-medium tabular-nums',
                    difference !== null && difference !== 0 && 'text-destructive'
                  )}
                >
                  {difference === null ? '—' : formatINR(difference)}
                </span>
              </span>
            </span>
          </div>
        </CardContent>
      )}
    </Card>
  )
}
