'use client'

/**
 * `S` -- set Hub status, with a note (§7). Reuses lib/actions/hub-status.ts's
 * setHubStatus directly, per the task brief -- this dialog is only a thin
 * keyboard-triggered front end for it, the same action the entry-detail
 * screen's HubStatusSection calls. Only rendered/enabled when
 * `detail.canSetHubStatus` is true (source_document.entry_id is set) --
 * §7's "this is the point of the whole queue" note about earning the right
 * to move an entry forward presupposes an entry to move.
 */

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { setHubStatus } from '@/lib/actions/hub-status'

export function HubStatusDialog({
  open,
  onOpenChange,
  entryId,
  currentCode,
  options,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryId: number
  currentCode: string | null
  options: { id: number; code: string; label: string }[]
  onChanged: () => void
}) {
  const [code, setCode] = useState(currentCode ?? options[0]?.code ?? '')
  const [note, setNote] = useState('')
  const [isPending, startTransition] = useTransition()

  function handleSubmit() {
    const trimmed = note.trim()
    if (!trimmed) {
      toast.error('A note is required to change Hub status.')
      return
    }
    startTransition(async () => {
      const result = await setHubStatus({ entryIds: [entryId], hubStatusCode: code, note: trimmed })
      if (!result.success) {
        toast.error(result.error ?? 'Could not update Hub status.')
        return
      }
      toast.success('Hub status updated.')
      setNote('')
      onOpenChange(false)
      onChanged()
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set Hub status</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="review-hub-status">New status</Label>
          <Select value={code} onValueChange={setCode}>
            <SelectTrigger id="review-hub-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((opt) => (
                <SelectItem key={opt.id} value={opt.code}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="review-hub-status-note">Note (required)</Label>
          <Textarea
            id="review-hub-status-note"
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why is the status changing?"
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button type="button" onClick={handleSubmit} disabled={isPending || !note.trim()}>
            {isPending ? 'Updating…' : 'Update status'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
