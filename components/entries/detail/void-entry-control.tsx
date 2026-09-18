'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Ban } from 'lucide-react'
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
  DialogTrigger,
} from '@/components/ui/dialog'
import { voidEntries } from '@/lib/actions/entries'

/**
 * Single-entry counterpart to bulk-void-dialog.tsx (item 6,
 * departmental-portal-vanished-entry flow, 2026-09-19) — calls the same
 * shared `voidEntries` server action (lib/actions/entries.ts) with a
 * one-element `entryIds` array, same as how HubStatusSection's single-entry
 * control calls the shared `setHubStatus` action. This component owns no
 * void-mutation logic of its own.
 */
export function VoidEntryControl({ entryId }: { entryId: number }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)

  async function handleSubmit() {
    if (!note.trim()) {
      toast.error('A note is required to void an entry.')
      return
    }
    setPending(true)
    try {
      const result = await voidEntries({ entryIds: [entryId], note })
      if (!result.success) {
        toastError(result.error, { title: 'Could not void this entry.', context: 'void-entry-control' })
        return
      }
      toast.success('Entry voided.')
      setNote('')
      setOpen(false)
      router.refresh()
    } catch (err) {
      toastError(err instanceof Error ? err.message : null, { title: 'Could not void this entry.', context: 'void-entry-control' })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Ban className="h-3.5 w-3.5" />
          Void this entry
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void this entry</DialogTitle>
          <DialogDescription>
            Voided entries are excluded from Hub export — a note is required so the change is traceable.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="void-entry-note">Note (required)</Label>
            <Textarea
              id="void-entry-note"
              placeholder="Why is this entry being voided?"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
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
