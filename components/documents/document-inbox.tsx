'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { bulkAttachDocuments, deleteDocuments } from '@/lib/actions/documents'
import { BulkEnrichmentDialog } from '@/components/entries/bulk-enrichment-dialog'
import type { LookupOption } from '@/components/entries/types'
import { UploadDropzone } from './upload-dropzone'
import { DocumentTable } from './document-table'
import type { InboxDocumentView } from './types'

/**
 * While any document sits in 'uploaded' or 'processing', poll the narrow
 * `GET /api/documents/status` endpoint (checklist 2.5/2.6) instead of
 * `router.refresh()`-ing the whole RSC tree on a timer — that used to re-run
 * six queries including a 5,000-row `entries` fetch every tick, whether or
 * not anything had actually changed.
 */
const PENDING_STATUSES: ReadonlySet<InboxDocumentView['uploadStatus']> = new Set(['uploaded', 'processing'])

/** 4s -> 8s -> 15s: backs off after each tick that finds no change, resets whenever the polled set or a document's status changes (checklist 2.7). */
const POLL_BACKOFF_MS = [4000, 8000, 15000] as const

interface StatusResponseDoc {
  id: number
  uploadStatus: InboxDocumentView['uploadStatus']
  hasExtraction: boolean
}

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
  queueStalled = false,
  adminHeadOptions,
  zoneOptions,
  costCenterOptions,
}: {
  initialDocuments: InboxDocumentView[]
  canAct: boolean
  /** True when the oldest queued `extract_document` job has been sitting for more than ~10 minutes (checklist 2.15, D8) — a stalled pipeline made visible instead of silent. */
  queueStalled?: boolean
  /** Passed straight through to DocumentTable → DocumentCard (checklist 5.11's inline zone/head prompt) and to the bulk-attach follow-up dialog below (checklist 5.12). Fetched once in app/(app)/documents/page.tsx rather than per-card. */
  adminHeadOptions: LookupOption[]
  zoneOptions: LookupOption[]
  /** Only needed for the bulk-attach follow-up dialog (5.12) — the single-attach inline prompt (5.11) doesn't touch cost center. */
  costCenterOptions: LookupOption[]
}) {
  const router = useRouter()
  const [documents, setDocuments] = useState(initialDocuments)
  const [chosenByDocument, setChosenByDocument] = useState<Map<number, number | null>>(
    () => new Map(initialDocuments.map((d) => [d.id, d.extraction[0]?.candidates[0]?.entryId ?? null]))
  )
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulkPending, setBulkPending] = useState(false)
  const [deletePending, setDeletePending] = useState(false)
  // Follow-up step after a successful bulk attach (checklist 5.12): reuses
  // BulkEnrichmentDialog unmodified, scoped to only the entries that were
  // actually attached (a partial bulk-attach failure must not offer to
  // classify entries whose document never got attached).
  const [enrichmentDialogOpen, setEnrichmentDialogOpen] = useState(false)
  const [enrichmentDialogEntryIds, setEnrichmentDialogEntryIds] = useState<number[]>([])

  useEffect(() => {
    setDocuments(initialDocuments)
    setChosenByDocument((current) => {
      const next = new Map<number, number | null>()
      for (const doc of initialDocuments) {
        next.set(
          doc.id,
          current.has(doc.id) ? current.get(doc.id) ?? null : doc.extraction[0]?.candidates[0]?.entryId ?? null
        )
      }
      return next
    })
    setSelected((current) => {
      const validIds = new Set(initialDocuments.map((d) => d.id))
      return new Set([...current].filter((id) => validIds.has(id)))
    })
  }, [initialDocuments])

  // Kept in a ref so the polling effect below can always read the latest
  // documents inside an async tick without re-subscribing on every render.
  const documentsRef = useRef(documents)
  useEffect(() => {
    documentsRef.current = documents
  }, [documents])

  useEffect(() => {
    const pendingIds = documents.filter((d) => PENDING_STATUSES.has(d.uploadStatus)).map((d) => d.id)
    if (pendingIds.length === 0) return

    let cancelled = false
    let backoffIndex = 0
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    function scheduleNext() {
      if (cancelled || document.visibilityState === 'hidden') return
      const delay = POLL_BACKOFF_MS[Math.min(backoffIndex, POLL_BACKOFF_MS.length - 1)]
      timeoutId = setTimeout(() => void tick(), delay)
    }

    async function tick() {
      timeoutId = null
      if (cancelled || document.visibilityState === 'hidden') return

      const currentPendingIds = documentsRef.current
        .filter((d) => PENDING_STATUSES.has(d.uploadStatus))
        .map((d) => d.id)
      if (currentPendingIds.length === 0) return

      try {
        const res = await fetch(`/api/documents/status?ids=${currentPendingIds.join(',')}`)
        if (cancelled) return
        if (!res.ok) {
          backoffIndex = Math.min(backoffIndex + 1, POLL_BACKOFF_MS.length - 1)
          scheduleNext()
          return
        }
        const body = (await res.json()) as { documents?: StatusResponseDoc[] }
        if (cancelled) return
        const serverById = new Map((body.documents ?? []).map((d) => [d.id, d]))

        let anyChange = false
        let completed = false
        const patched = documentsRef.current.map((doc) => {
          const server = serverById.get(doc.id)
          if (!server) return doc
          // extraction is 1:many per document (multi-bill PDFs) — an empty
          // array means "not extracted yet", same signal the old single-bill
          // `extraction !== null` check used to read off a nullable object.
          const wasExtracted = doc.extraction.length > 0
          const statusChanged = server.uploadStatus !== doc.uploadStatus
          const extractionArrived = server.hasExtraction && !wasExtracted
          if (!statusChanged && !extractionArrived) return doc

          anyChange = true
          if (server.uploadStatus === 'processed' || server.uploadStatus === 'failed' || extractionArrived) {
            // Only a real router.refresh() brings in the actual extracted
            // fields and candidate rankings — leave this document's local
            // state alone and let the RSC round trip replace it.
            completed = true
            return doc
          }
          return { ...doc, uploadStatus: server.uploadStatus }
        })

        if (completed) {
          router.refresh()
          return
        }
        if (anyChange) {
          // Patching triggers this effect's own cleanup + re-run (documents
          // changed), which naturally resets backoffIndex to 0 and
          // recomputes the pending set — no manual reset needed here.
          setDocuments(patched)
          return
        }

        backoffIndex = Math.min(backoffIndex + 1, POLL_BACKOFF_MS.length - 1)
        scheduleNext()
      } catch {
        if (cancelled) return
        backoffIndex = Math.min(backoffIndex + 1, POLL_BACKOFF_MS.length - 1)
        scheduleNext()
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        if (timeoutId === null && !cancelled) void tick()
      } else if (timeoutId !== null) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    scheduleNext()

    return () => {
      cancelled = true
      if (timeoutId !== null) clearTimeout(timeoutId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
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
      const attachedPairs = pairs.filter((p) => !result.failedDocumentIds.includes(p.documentId))
      const attachedIds = new Set(attachedPairs.map((p) => p.documentId))
      setDocuments((current) => current.filter((d) => !attachedIds.has(d.id)))
      setSelected(new Set())
      if (result.error) {
        toast.warning(result.error)
      } else {
        toast.success(`Attached ${result.attachedCount} document${result.attachedCount === 1 ? '' : 's'}.`)
      }
      // Offer the zone/admin-head follow-up only for entries a document was
      // actually attached to (checklist 5.12) — deduped since two documents
      // could in principle target the same entry.
      const attachedEntryIds = Array.from(new Set(attachedPairs.map((p) => p.entryId)))
      if (attachedEntryIds.length > 0) {
        setEnrichmentDialogEntryIds(attachedEntryIds)
        setEnrichmentDialogOpen(true)
      }
      router.refresh()
    })()
  }

  /**
   * The only removal action on this screen. There used to be a separate
   * non-destructive "Cancel tracking" (flip match_status, keep every row)
   * alongside this. Removed on direct instruction: a "hidden" document that
   * still sits in the database, still holds a queued extraction job, and
   * still costs money when a worker gets to it is not what "canceled" means
   * to someone using this screen — if it's hidden, it should be gone. So
   * there is one action now, and it does the real thing: removes the PDF
   * from storage and every row derived from it, and drops any extraction
   * still queued for it (lib/actions/documents.ts's deleteDocuments).
   *
   * Confirmed with a native confirm() rather than a dialog component:
   * this is the one irreversible action on the screen and should not be one
   * stray click away.
   */
  function handleBulkDelete() {
    const ids = [...selected]
    if (ids.length === 0) {
      toast.error('Select at least one document to delete.')
      return
    }
    const noun = ids.length === 1 ? 'document' : 'documents'
    if (
      !window.confirm(
        `Permanently delete ${ids.length} ${noun}?\n\n` +
          `This removes the uploaded PDF and everything extracted from it, and stops any extraction still queued for it. ` +
          `It cannot be undone.`
      )
    ) {
      return
    }

    setDeletePending(true)
    void (async () => {
      const result = await deleteDocuments(ids)
      setDeletePending(false)
      if (!result.success) {
        toastError(result.error, { title: 'Delete failed.', context: 'document-inbox' })
        return
      }
      const deletedIds = new Set(ids.filter((id) => !result.failedDocumentIds.includes(id)))
      setDocuments((current) => current.filter((d) => !deletedIds.has(d.id)))
      setSelected(new Set())
      if (result.error) {
        toast.warning(result.error)
      } else {
        toast.success(`Deleted ${result.deletedCount} ${result.deletedCount === 1 ? 'document' : 'documents'}.`)
      }
      router.refresh()
    })()
  }

  const anyPending = bulkPending || deletePending

  return (
    <div className="flex flex-col gap-6">
      {queueStalled && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300/50 bg-amber-50 px-3 py-2.5 text-sm dark:border-amber-900 dark:bg-amber-950/40">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />
          <p className="text-amber-900 dark:text-amber-200">
            Extraction is running behind. Uploads may take longer than usual.
          </p>
        </div>
      )}

      <UploadDropzone onUploaded={() => router.refresh()} />

      {canAct && selectedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-4 py-2.5">
          <p className="text-sm">
            {selectedCount} document{selectedCount === 1 ? '' : 's'} selected
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={anyPending}>
              Clear
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBulkDelete}
              disabled={anyPending}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {deletePending ? 'Deleting…' : `Delete (${selectedCount})`}
            </Button>
            <Button size="sm" onClick={handleBulkAttach} disabled={anyPending}>
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
          adminHeadOptions={adminHeadOptions}
          zoneOptions={zoneOptions}
        />
      )}

      <BulkEnrichmentDialog
        open={enrichmentDialogOpen}
        onOpenChange={setEnrichmentDialogOpen}
        entryIds={enrichmentDialogEntryIds}
        adminHeadOptions={adminHeadOptions}
        zoneOptions={zoneOptions}
        costCenterOptions={costCenterOptions}
        onDone={() => router.refresh()}
      />
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
