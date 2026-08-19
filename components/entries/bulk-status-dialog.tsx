'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SelectNative } from '@/components/ui/select-native'
import { setHubStatus } from '@/lib/actions/hub-status'
import type { LookupOption } from './types'

// MASTER-PLAN §5 row 3: "Bulk Hub-status change with a required note — the
// primary way staff set awaiting verification/validation at volume." Calls
// the SHARED server action in lib/actions/hub-status.ts — the same one the
// entry-detail screen's single-entry control uses — so both places behave
// identically (trigger-stamped changed_at/by, change log, export-queue
// reset). This component owns no status-mutation logic of its own.
export function BulkStatusDialog({
  open,
  onOpenChange,
  entryIds,
  hubStatuses,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryIds: number[]
  hubStatuses: LookupOption[]
  onDone: () => void
}) {
  const exportableStatuses = hubStatuses // codes come straight from public.hub_status; all are legal targets
  const [code, setCode] = useState('')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)

  async function handleSubmit() {
    if (!code) {
      toast.error('Choose a Hub status.')
      return
    }
    if (!note.trim()) {
      toast.error('A note is required for a Hub-status change.')
      return
    }
    setPending(true)
    try {
      const result = await setHubStatus({ entryIds, hubStatusCode: code, note })
      if (!result.success) {
        toastError(result.error, { context: 'bulk-status-dialog' })
        return
      }
      if (result.updatedCount < result.requestedCount) {
        toast.warning(
          `Updated ${result.updatedCount} of ${result.requestedCount} entries — the rest were outside your access (read-only role or a different department).`
        )
      } else {
        toast.success(`Hub status set on ${result.updatedCount} ${result.updatedCount === 1 ? 'entry' : 'entries'}.`)
      }
      setCode('')
      setNote('')
      onOpenChange(false)
      onDone()
    } catch (err) {
      toastError(err instanceof Error ? err.message : null, { title: 'Could not update Hub status.', context: 'bulk-status-dialog' })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set Hub status</DialogTitle>
          <DialogDescription>
            Applies to {entryIds.length} selected {entryIds.length === 1 ? 'entry' : 'entries'}. This is pushed back
            to the modules on the next export — a note is required so the change is traceable.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-hub-status">New Hub status</Label>
            <SelectNative id="bulk-hub-status" value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">Select a status…</option>
              {exportableStatuses.map((s) => (
                <option key={s.id} value={s.code ?? String(s.id)}>
                  {s.label}
                </option>
              ))}
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-hub-status-note">Note (required)</Label>
            <Textarea
              id="bulk-hub-status-note"
              placeholder="Why is this changing? e.g. 'Documents verified against tenant amount, 08 Aug.'"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? 'Applying…' : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
