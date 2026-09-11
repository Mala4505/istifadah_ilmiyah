'use client'

// `E` -- flag as exception (§7). 2026-09-11: reviewers pick one of three
// plain-language reasons (Not clear / Not visible / Other) instead of typing
// free text from scratch every time -- see MANUAL_FLAG_REASONS' doc comment
// (components/exceptions/labels.ts) for why this maps straight to
// exception_type. Only "Other" requires a note; the other two are
// self-explanatory and the note is optional extra context.

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { flagReviewException } from '@/lib/actions/review'
import { MANUAL_FLAG_REASONS, type ManualFlagReason } from '@/components/exceptions/labels'

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
  const [reason, setReason] = useState<ManualFlagReason>('not_clear')
  const [note, setNote] = useState('')
  const [isPending, startTransition] = useTransition()

  const noteRequired = reason === 'other'

  function handleSubmit() {
    const trimmed = note.trim()
    if (noteRequired && !trimmed) {
      toast.error('A note is required for "Other".')
      return
    }
    startTransition(async () => {
      const result = await flagReviewException({
        sourceDocumentId,
        documentExtractionId,
        entryId,
        reason,
        note: trimmed,
      })
      if (!result.ok) {
        toastError(result.error, { context: 'exception-dialog' })
        return
      }
      toast.success('Exception flagged.')
      setReason('not_clear')
      setNote('')
      onOpenChange(false)
      onFlagged()
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setReason('not_clear')
          setNote('')
        }
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Flag as exception</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          {MANUAL_FLAG_REASONS.map((r) => (
            <Button
              key={r.value}
              type="button"
              size="sm"
              variant={reason === r.value ? 'default' : 'outline'}
              className="flex-1"
              onClick={() => setReason(r.value)}
            >
              {r.label}
            </Button>
          ))}
        </div>
        <Textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={noteRequired ? "What's wrong with this document?" : 'Add a note (optional)'}
          rows={4}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              handleSubmit()
            }
          }}
        />
        <DialogFooter>
          <Button type="button" onClick={handleSubmit} disabled={isPending || (noteRequired && !note.trim())}>
            {isPending ? 'Flagging…' : 'Flag exception'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
