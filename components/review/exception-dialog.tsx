'use client'

// `E` -- flag as exception, with a required note (§7).

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { flagReviewException } from '@/lib/actions/review'

export function ExceptionDialog({
  open,
  onOpenChange,
  sourceDocumentId,
  documentExtractionId,
  entryId,
  onFlagged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sourceDocumentId: number
  documentExtractionId: number
  entryId: number | null
  onFlagged: () => void
}) {
  const [note, setNote] = useState('')
  const [isPending, startTransition] = useTransition()

  function handleSubmit() {
    const trimmed = note.trim()
    if (!trimmed) {
      toast.error('A note is required to flag an exception.')
      return
    }
    startTransition(async () => {
      const result = await flagReviewException({
        sourceDocumentId,
        documentExtractionId,
        entryId,
        note: trimmed,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Exception flagged.')
      setNote('')
      onOpenChange(false)
      onFlagged()
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Flag as exception</DialogTitle>
        </DialogHeader>
        <Textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What's wrong with this document?"
          rows={4}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              handleSubmit()
            }
          }}
        />
        <DialogFooter>
          <Button type="button" onClick={handleSubmit} disabled={isPending || !note.trim()}>
            {isPending ? 'Flagging…' : 'Flag exception'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
