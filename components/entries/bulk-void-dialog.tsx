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
import { voidEntries } from '@/lib/actions/entries'

// Item 6 (departmental-portal-vanished-entry flow, 2026-09-19): bulk void
// with a required note. Mirrors bulk-status-dialog.tsx's shape (props,
// loading/error/success handling, toast/partial-success messaging) and calls
// the shared `voidEntries` server action (lib/actions/entries.ts) — the same
// one the entry-detail screen's single-entry control uses — so this
// component owns no void-mutation logic of its own.
export function BulkVoidDialog({
  open,
  onOpenChange,
  entryIds,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryIds: number[]
  onDone: () => void
}) {
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)

  async function handleSubmit() {
    if (!note.trim()) {
      toast.error('A note is required to void an entry.')
      return
    }
    setPending(true)
    try {
      const result = await voidEntries({ entryIds, note })
      if (!result.success) {
        toastError(result.error, { context: 'bulk-void-dialog' })
        return
      }
      if (result.updatedCount < result.requestedCount) {
        toast.warning(
          `Voided ${result.updatedCount} of ${result.requestedCount} entries — the rest were outside your access (read-only role or a different department).`
        )
      } else {
        toast.success(`Voided ${result.updatedCount} ${result.updatedCount === 1 ? 'entry' : 'entries'}.`)
      }
      setNote('')
      onOpenChange(false)
      onDone()
    } catch (err) {
      toastError(err instanceof Error ? err.message : null, { title: 'Could not void entries.', context: 'bulk-void-dialog' })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void entries</DialogTitle>
          <DialogDescription>
            Applies to {entryIds.length} selected {entryIds.length === 1 ? 'entry' : 'entries'}. Voided entries are
            excluded from Hub export — a note is required so the change is traceable.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-void-note">Note (required)</Label>
            <Textarea
              id="bulk-void-note"
              placeholder="Why are these entries being voided?"
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
          <Button variant="destructive" onClick={handleSubmit} disabled={pending}>
            {pending ? 'Voiding…' : 'Void'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
