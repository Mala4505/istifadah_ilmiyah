'use client'

import { useEffect, useState } from 'react'
import { Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toastError } from '@/components/ui/error-toast'
import { getDocumentViewDetail, type DocumentViewDetail } from '@/lib/actions/documents'
import { formatINR, formatDate } from '@/lib/reports/format'

/**
 * Read-only "what did the bill actually say" lookup, reachable from
 * LinkedDocuments without leaving Entries or re-entering the /review queue.
 * Line items render as a plain table (not the editable input-grid /review
 * uses) — this is a lookup, not an edit surface, so a formal table reads
 * more clearly than a row of boxes.
 */
export function BillViewModal({
  documentId,
  entryId,
  triggerLabel = 'View details',
}: {
  documentId: number
  entryId?: number
  triggerLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<DocumentViewDetail | null>(null)

  useEffect(() => {
    if (!open || detail !== null) return
    setLoading(true)
    void (async () => {
      const result = await getDocumentViewDetail(documentId, entryId)
      setLoading(false)
      if (!result.ok) {
        toastError(result.error, { context: 'bill-view-modal' })
        setOpen(false)
        return
      }
      setDetail(result.detail)
    })()
  }, [open, detail, documentId, entryId])

  const lineItemsTotal =
    detail && detail.lineItems.length > 0
      ? detail.lineItems.reduce((sum, item) => sum + (item.amount ?? 0), 0)
      : null

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="ml-1.5">{triggerLabel}</span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setDetail(null)
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogTitle>{detail?.originalFilename ?? 'Bill details'}</DialogTitle>
          <DialogDescription>
            {detail && detail.billCount > 1 ? `Bill ${detail.billIndex} of ${detail.billCount} in this PDF · ` : ''}
            Read-only — what was read from this bill{detail?.verifiedAt ? ', as verified on Review' : ''}.
          </DialogDescription>

          {loading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          ) : detail ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-md border border-border p-3 text-sm sm:grid-cols-3">
                <Field label="Vendor" value={detail.vendorName} />
                <Field label="GSTIN" value={detail.vendorGstin} />
                <Field label="Phone" value={detail.vendorPhone} />
                <Field label="Invoice #" value={detail.invoiceNumber} />
                <Field label="Invoice date" value={detail.invoiceDate ? formatDate(detail.invoiceDate) : null} />
                <Field label="Reviewed" value={detail.verifiedAt ? formatDate(detail.verifiedAt) : 'Not yet reviewed'} />
              </div>

              <div className="overflow-x-auto rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Qty</TableHead>
                      <TableHead>Unit</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.lineItems.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                          No line items were extracted from this bill.
                        </TableCell>
                      </TableRow>
                    ) : (
                      detail.lineItems.map((item, index) => (
                        <TableRow key={item.id}>
                          <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                          <TableCell className="whitespace-normal">{item.description || '—'}</TableCell>
                          <TableCell>{item.quantity ?? '—'}</TableCell>
                          <TableCell>{item.unit || '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatINR(item.rate)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatINR(item.amount)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                  {lineItemsTotal !== null && (
                    <TableFooter>
                      <TableRow>
                        <TableCell colSpan={5}>Line items sum</TableCell>
                        <TableCell className="text-right tabular-nums">{formatINR(lineItemsTotal)}</TableCell>
                      </TableRow>
                    </TableFooter>
                  )}
                </Table>
              </div>

              <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
                <Amount label="Subtotal" value={detail.subtotal} />
                <Amount label="Tax" value={detail.taxAmount} />
                <Amount label="Total" value={detail.totalAmount} emphasize />
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium">{value || '—'}</span>
    </div>
  )
}

function Amount({ label, value, emphasize }: { label: string; value: number | null; emphasize?: boolean }) {
  return (
    <span>
      <span className="text-muted-foreground">{label}: </span>
      <span className={emphasize ? 'font-semibold tabular-nums' : 'font-medium tabular-nums'}>
        {formatINR(value)}
      </span>
    </span>
  )
}
