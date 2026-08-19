'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { bulkAttachDocuments, cancelDocumentTracking } from '@/lib/actions/documents'
import { UploadDropzone } from './upload-dropzone'
import { DocumentTable } from './document-table'
import type { InboxDocumentView } from './types'

/** While any document sits in 'uploaded' or 'processing', poll the RSC data path so the stage tracker reflects a background worker's progress without a dedicated status endpoint. */
const PENDING_STATUSES: ReadonlySet<InboxDocumentView['uploadStatus']> = new Set(['uploaded', 'processing'])
const POLL_INTERVAL_MS = 4000

/**
 * Client shell for /documents (MASTER-PLAN §11.2 Day 3): owns the upload
 * dropzone, the per-document "which entry did you pick" state that both
 * the single-attach button and bulk-attach draw from, and bulk selection.
 * Mirrors components/admin/vendor-merge-panel.tsx's shape — local state
 * seeded from server props, resynced via useEffect when the RSC re-fetches
 * after a mutation (router.refresh(), called from the mutating components
 * themselves so this component doesn't need to know which action fired).
 */
export function DocumentInbox({
  initialDocuments,
  canAct,
}: {
  initialDocuments: InboxDocumentView[]
  canAct: boolean
}) {
  const router = useRouter()
  const [documents, setDocuments] = useState(initialDocuments)
  const [chosenByDocument, setChosenByDocument] = useState<Map<number, number | null>>(
    () => new Map(initialDocuments.map((d) => [d.id, d.candidates[0]?.entryId ?? null]))
  )
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulkPending, setBulkPending] = useState(false)
  const [cancelPending, setCancelPending] = useState(false)

  useEffect(() => {
    setDocuments(initialDocuments)
    setChosenByDocument((current) => {
      const next = new Map<number, number | null>()
      for (const doc of initialDocuments) {
        next.set(doc.id, current.has(doc.id) ? current.get(doc.id) ?? null : doc.candidates[0]?.entryId ?? null)
      }
      return next
    })
    setSelected((current) => {
      const validIds = new Set(initialDocuments.map((d) => d.id))
      return new Set([...current].filter((id) => validIds.has(id)))
    })
  }, [initialDocuments])

  useEffect(() => {
    const hasPending = documents.some((d) => PENDING_STATUSES.has(d.uploadStatus))
    if (!hasPending) return
    const interval = setInterval(() => {
      router.refresh()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [documents, router])

  function toggleSelected(documentId: number) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(documentId)) next.delete(documentId)
      else next.add(documentId)
      return next
    })
  }

  function chooseEntry(documentId: number, entryId: number | null) {
    setChosenByDocument((current) => {
      const next = new Map(current)
      next.set(documentId, entryId)
      return next
    })
    // A document deselected from bulk once its candidate changes to "none"
    // would otherwise sit selected-but-unattachable — drop it instead.
    if (entryId === null) {
      setSelected((current) => {
        if (!current.has(documentId)) return current
        const next = new Set(current)
        next.delete(documentId)
        return next
      })
    }
  }

  function removeDocumentLocally(documentId: number) {
    setDocuments((current) => current.filter((d) => d.id !== documentId))
    setSelected((current) => {
      if (!current.has(documentId)) return current
      const next = new Set(current)
      next.delete(documentId)
      return next
    })
  }

  const selectedCount = selected.size

  function handleBulkAttach() {
    const pairs = [...selected]
      .map((documentId) => ({ documentId, entryId: chosenByDocument.get(documentId) ?? null }))
      .filter((p): p is { documentId: number; entryId: number } => p.entryId !== null)

    if (pairs.length === 0) {
      toast.error('Select at least one document with a chosen entry.')
      return
    }

    setBulkPending(true)
    void (async () => {
      const result = await bulkAttachDocuments(pairs)
      setBulkPending(false)
      if (!result.success) {
        toastError(result.error, { title: 'Bulk attach failed.', context: 'document-inbox' })
        return
      }
      const attachedIds = new Set(pairs.map((p) => p.documentId).filter((id) => !result.failedDocumentIds.includes(id)))
      setDocuments((current) => current.filter((d) => !attachedIds.has(d.id)))
      setSelected(new Set())
      if (result.error) {
        toast.warning(result.error)
      } else {
        toast.success(`Attached ${result.attachedCount} document${result.attachedCount === 1 ? '' : 's'}.`)
      }
      router.refresh()
    })()
  }

  function handleBulkCancel() {
    const ids = [...selected]
    if (ids.length === 0) {
      toast.error('Select at least one document to cancel.')
      return
    }

    setCancelPending(true)
    void (async () => {
      const result = await cancelDocumentTracking(ids)
      setCancelPending(false)
      if (!result.success) {
        toastError(result.error, { title: 'Cancel failed.', context: 'document-inbox' })
        return
      }
      const canceledIds = new Set(ids.filter((id) => !result.failedDocumentIds.includes(id)))
      setDocuments((current) => current.filter((d) => !canceledIds.has(d.id)))
      setSelected(new Set())
      if (result.error) {
        toast.warning(result.error)
      } else {
        toast.success(`Canceled tracking for ${result.canceledCount} document${result.canceledCount === 1 ? '' : 's'}.`)
      }
      router.refresh()
    })()
  }

  return (
    <div className="flex flex-col gap-6">
      <UploadDropzone onUploaded={() => router.refresh()} />

      {canAct && selectedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-4 py-2.5">
          <p className="text-sm">
            {selectedCount} document{selectedCount === 1 ? '' : 's'} selected
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={bulkPending || cancelPending}>
              Clear
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleBulkCancel}
              disabled={bulkPending || cancelPending}
            >
              {cancelPending ? 'Canceling…' : `Cancel tracking (${selectedCount})`}
            </Button>
            <Button size="sm" onClick={handleBulkAttach} disabled={bulkPending || cancelPending}>
              {bulkPending ? 'Attaching…' : `Attach ${selectedCount} selected`}
            </Button>
          </div>
        </div>
      )}

      {documents.length === 0 ? (
        <EmptyState />
      ) : (
        <DocumentTable
          documents={documents}
          canAct={canAct}
          selected={selected}
          onToggleSelected={toggleSelected}
          chosenByDocument={chosenByDocument}
          onChooseEntry={chooseEntry}
          onMutated={removeDocumentLocally}
        />
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-border py-10 text-center">
      <p className="text-sm font-medium">Inbox is empty</p>
      <p className="max-w-md text-xs text-muted-foreground">
        Every unmatched or suggested document has been attached or parked. New uploads land here as soon as they
        finish.
      </p>
    </div>
  )
}
