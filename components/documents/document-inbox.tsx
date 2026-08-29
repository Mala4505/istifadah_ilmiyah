'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { bulkAttachDocuments, deleteDocuments, getInboxMatchCandidates } from '@/lib/actions/documents'
import { setDocumentAssignees } from '@/lib/actions/assignment'
import { BulkEnrichmentDialog } from '@/components/entries/bulk-enrichment-dialog'
import type { LookupOption } from '@/components/entries/types'
import type { AssignableStaff } from '@/lib/assignment/queries'
import { UploadDropzone } from './upload-dropzone'
import { DocumentTable } from './document-table'
import { AssigneePicker, assigneeFirstNames } from './assignee-picker'
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
  currentStaffId,
  assignableStaff,
  queueStalled = false,
  adminHeadOptions,
  zoneOptions,
  costCenterOptions,
}: {
  initialDocuments: InboxDocumentView[]
  canAct: boolean
  /** The viewer's own staff id — for the bulk "Assign to me" quick action. */
  currentStaffId: string
  /** Active admins + superadmins for the upload picker and the bulk "Assign to…" dialog ("dividing the document inbox", 2026-08-29). Empty for a non-admin viewer. */
  assignableStaff: AssignableStaff[]
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
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  // Follow-up step after a successful bulk attach (checklist 5.12): reuses
  // BulkEnrichmentDialog unmodified, scoped to only the entries that were
  // actually attached (a partial bulk-attach failure must not offer to
  // classify entries whose document never got attached).
  const [enrichmentDialogOpen, setEnrichmentDialogOpen] = useState(false)
  const [enrichmentDialogEntryIds, setEnrichmentDialogEntryIds] = useState<number[]>([])
  // Bulk assignment ("dividing the document inbox", 2026-08-29): "Assign to…"
  // opens the shared AssigneePicker in a dialog; "Assign to me" is a
  // one-click path through the same server action.
  const [assignPending, setAssignPending] = useState(false)
  const [assignDialogOpen, setAssignDialogOpen] = useState(false)
  const [assignDraft, setAssignDraft] = useState<string[]>([])

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

  // Checklist 2.9 (D6): ranking candidates against the full entries pool
  // used to run inline in app/(app)/documents/page.tsx's own render, on
  // every load. It's fetched here instead — once after mount, and again
  // whenever the server sends a fresh `initialDocuments` (a new upload, a
  // completed extraction, a mutation's router.refresh()) — so the page's
  // own render never pays for it. `getInboxMatchCandidates` always
  // recomputes fresh against the CURRENT entries table rather than reading
  // anything persisted, so a document that arrived before its match was
  // imported still picks it up on the very next fetch, not never.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const candidatesByExtractionId = await getInboxMatchCandidates()
      if (cancelled) return

      setDocuments((current) =>
        current.map((doc) => ({
          ...doc,
          extraction: doc.extraction.map((bill) => {
            const candidates = candidatesByExtractionId[bill.id]
            return candidates ? { ...bill, candidates } : bill
          }),
        }))
      )

      // Seed the default choice for any document that doesn't already have
      // one — mirrors the synchronous `?? null` seed above, just applied
      // once real rankings are in rather than assumed present at mount.
      // Never overrides a choice that's already set, whether that came from
      // an earlier fetch or the reviewer's own manual pick.
      setChosenByDocument((current) => {
        let changed = false
        const next = new Map(current)
        for (const doc of initialDocuments) {
          if (next.get(doc.id)) continue
          const firstBillId = doc.extraction[0]?.id
          const topCandidateId =
            firstBillId !== undefined ? candidatesByExtractionId[firstBillId]?.[0]?.entryId : undefined
          if (topCandidateId !== undefined) {
            next.set(doc.id, topCandidateId)
            changed = true
          }
        }
        return changed ? next : current
      })
    })()
    return () => {
      cancelled = true
    }
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

  // Tri-state select-all for the current table page (hub certification §3.5).
  // The table hands us the ids currently on screen; if every one is already
  // selected this clears them, otherwise it adds the missing ones. Selection
  // of documents on other pages is left untouched — it already survives
  // paging and filtering (bulk actions read the full `selected` set).
  function togglePage(documentIds: number[]) {
    setSelected((current) => {
      const allSelected = documentIds.length > 0 && documentIds.every((id) => current.has(id))
      const next = new Set(current)
      for (const id of documentIds) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
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
   * Confirmed with the app's own Dialog component, not a native
   * window.confirm() -- every confirmation in the app goes through the same
   * custom modal (matches review-workspace.tsx's confirm dialog and
   * pdf-viewer.tsx's skip dialog) rather than the browser's own styling,
   * which a reviewer can dismiss without reading and which some browsers
   * suppress outright when several fire in a row.
   */
  function handleBulkDelete() {
    if (selected.size === 0) {
      toast.error('Select at least one document to delete.')
      return
    }
    setDeleteConfirmOpen(true)
  }

  function confirmBulkDelete() {
    const ids = [...selected]
    setDeleteConfirmOpen(false)
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

  /**
   * Replace the assignee set for every selected document via the
   * `set_source_document_assignees` RPC (`setDocumentAssignees`). An empty
   * `staffIds` sends them back to the pool. Partial success (some rows
   * refused by the anti-overtaking rule) comes back as `refusedCount` — a
   * warning, not an error — matching bulkAttachDocuments' shape.
   */
  function runBulkAssign(staffIds: string[]) {
    const ids = [...selected]
    if (ids.length === 0) {
      toast.error('Select at least one document to assign.')
      return
    }
    setAssignPending(true)
    void (async () => {
      const result = await setDocumentAssignees(ids, staffIds)
      setAssignPending(false)
      if (!result.ok) {
        toastError(result.error, { title: 'Assignment failed.', context: 'document-inbox' })
        return
      }
      setAssignDialogOpen(false)
      setSelected(new Set())
      if (result.refusedCount > 0) {
        toast.warning(
          `${result.updatedCount} reassigned; ${result.refusedCount} left unchanged — a superadmin can move those.`
        )
      } else {
        const target =
          staffIds.length === 0
            ? 'the pool'
            : assigneeFirstNames(assignableStaff, staffIds) || 'the selected staff'
        toast.success(
          `Assigned ${result.updatedCount} document${result.updatedCount === 1 ? '' : 's'} to ${target}.`
        )
      }
      router.refresh()
    })()
  }

  const anyPending = bulkPending || deletePending || assignPending

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

      {/* Compact once the inbox already has documents to show (§7.8f) — the
          full-size, inviting panel is reserved for a first-time/empty inbox
          so it doesn't push the list below the fold as it grows. */}
      <UploadDropzone
        onUploaded={() => router.refresh()}
        compact={documents.length > 0}
        assignableStaff={canAct ? assignableStaff : []}
      />

      {canAct && selectedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-4 py-2.5">
          <p className="text-sm">
            {selectedCount} document{selectedCount === 1 ? '' : 's'} selected
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={anyPending}>
              Clear
            </Button>
            {assignableStaff.length > 0 && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => runBulkAssign([currentStaffId])}
                  disabled={anyPending}
                >
                  {assignPending ? 'Assigning…' : 'Assign to me'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAssignDraft([])
                    setAssignDialogOpen(true)
                  }}
                  disabled={anyPending}
                >
                  Assign to…
                </Button>
              </>
            )}
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
          onTogglePage={togglePage}
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

      <Dialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Assign {selectedCount} {selectedCount === 1 ? 'document' : 'documents'}
            </DialogTitle>
            <DialogDescription>
              Pick one or more admins, or leave unassigned to send these back to the shared pool. This replaces
              the current assignment.
            </DialogDescription>
          </DialogHeader>
          <AssigneePicker staff={assignableStaff} value={assignDraft} onChange={setAssignDraft} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAssignDialogOpen(false)} disabled={assignPending}>
              Cancel
            </Button>
            <Button type="button" onClick={() => runBulkAssign(assignDraft)} disabled={assignPending}>
              {assignPending
                ? 'Assigning…'
                : assignDraft.length === 0
                  ? 'Send to pool'
                  : `Assign to ${assigneeFirstNames(assignableStaff, assignDraft)}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Permanently delete {selected.size} {selected.size === 1 ? 'document' : 'documents'}?
            </DialogTitle>
            <DialogDescription>
              This removes the uploaded PDF and everything extracted from it, and stops any extraction still queued
              for it. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmBulkDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
