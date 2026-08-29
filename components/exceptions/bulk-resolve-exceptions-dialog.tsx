'use client'

import * as React from 'react'
import { AlertTriangle } from 'lucide-react'
import { useRouter } from 'next/navigation'
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
import { resolveExceptions, type ResolveExceptionOutcome } from '@/lib/actions/exceptions'
import { describeSelectionSpan } from '@/components/exceptions/bulk-selection'
import { exceptionTypeLabel, SEVERITY_GROUP_LABELS } from '@/components/exceptions/labels'

/**
 * Resolve or dismiss several open exceptions at once
 * (docs/hub-screen-certification.md §3.5). One shared note applies to the
 * whole batch, so when the selection spans mixed exception types or
 * severities the dialog warns before submit — and a "dismiss" still gets its
 * own confirm step, since a dismissed exception can't be reopened.
 */
export function BulkResolveExceptionsDialog({
  open,
  onOpenChange,
  rows,
  initialOutcome = 'resolved',
  onResolved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: { id: number; exception_type: string; severity: string }[]
  initialOutcome?: ResolveExceptionOutcome
  onResolved: () => void
}) {
  const router = useRouter()
  const [note, setNote] = React.useState('')
  const [outcome, setOutcome] = React.useState<ResolveExceptionOutcome>(initialOutcome)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [confirmStep, setConfirmStep] = React.useState<null | 'dismiss' | 'discard'>(null)

  // Each open reflects which bar button launched it (Resolve vs Dismiss).
  React.useEffect(() => {
    if (open) {
      setOutcome(initialOutcome)
      setConfirmStep(null)
    }
  }, [open, initialOutcome])

  const span = describeSelectionSpan(rows)
  const count = rows.length
  const noun = count === 1 ? 'exception' : 'exceptions'

  function reset() {
    setNote('')
    setOutcome(initialOutcome)
    setConfirmStep(null)
  }

  function requestClose(next: boolean) {
    if (next) {
      onOpenChange(true)
      return
    }
    if (isSubmitting) return
    // Don't let Escape / outside-click silently bin a typed note.
    if (note.trim() !== '' && confirmStep === null) {
      setConfirmStep('discard')
      return
    }
    reset()
    onOpenChange(false)
  }

  async function runSubmit() {
    setIsSubmitting(true)
    try {
      const result = await resolveExceptions({
        exceptionIds: rows.map((r) => r.id),
        outcome,
        note,
      })
      if (!result.ok) {
        toastError(result.error, { title: 'Could not update exceptions', context: 'bulk-resolve-exceptions-dialog' })
        return
      }
      const verb = outcome === 'resolved' ? 'Resolved' : 'Dismissed'
      toast.success(
        result.skipped > 0
          ? `${verb} ${result.updated} of ${count} ${noun} · ${result.skipped} already closed`
          : `${verb} ${result.updated} ${result.updated === 1 ? 'exception' : 'exceptions'}`
      )
      reset()
      onOpenChange(false)
      onResolved()
      router.refresh()
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (note.trim() === '') return
    if (outcome === 'dismissed' && confirmStep !== 'dismiss') {
      setConfirmStep('dismiss')
      return
    }
    void runSubmit()
  }

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent>
        {confirmStep === 'discard' ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Discard your note?</DialogTitle>
              <DialogDescription>Your resolution note hasn&rsquo;t been submitted yet.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirmStep(null)}>
                Keep editing
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  reset()
                  onOpenChange(false)
                }}
              >
                Discard
              </Button>
            </DialogFooter>
          </div>
        ) : confirmStep === 'dismiss' ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>
                Dismiss {count} {noun}?
              </DialogTitle>
              <DialogDescription>
                Dismissed exceptions stay in the audit trail but can&rsquo;t be reopened. The same note is
                recorded on each.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirmStep(null)} disabled={isSubmitting}>
                Back
              </Button>
              <Button type="button" variant="destructive" onClick={() => void runSubmit()} disabled={isSubmitting}>
                {isSubmitting ? 'Dismissing…' : `Dismiss ${count} ${noun}`}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>
                {outcome === 'resolved' ? 'Resolve' : 'Dismiss'} {count} {noun}
              </DialogTitle>
              <DialogDescription>
                One note is recorded on every selected exception.
              </DialogDescription>
            </DialogHeader>

            {span.shouldWarn && (
              <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <div className="flex flex-col gap-1">
                  <p className="font-medium">This selection is mixed.</p>
                  {span.mixedTypes && (
                    <p>
                      {span.types.length} exception types: {span.types.map(exceptionTypeLabel).join(', ')}.
                    </p>
                  )}
                  {span.mixedSeverities && (
                    <p>
                      {span.severities.length} severities:{' '}
                      {span.severities.map((s) => SEVERITY_GROUP_LABELS[s] ?? s).join(', ')}.
                    </p>
                  )}
                  <p className="text-amber-800 dark:text-amber-300">
                    The same note will justify closing all of them — make sure that&rsquo;s right.
                  </p>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={outcome === 'resolved' ? 'default' : 'outline'}
                onClick={() => setOutcome('resolved')}
              >
                Resolved
              </Button>
              <Button
                type="button"
                size="sm"
                variant={outcome === 'dismissed' ? 'default' : 'outline'}
                onClick={() => setOutcome('dismissed')}
              >
                Dismiss
              </Button>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bulk-resolution-note">
                Resolution note <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="bulk-resolution-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What did you check, and why is this OK to close for every selected item?"
                required
                minLength={1}
                rows={4}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Required — &ldquo;resolved&rdquo; with no reason is not an audit trail.
              </p>
            </div>

            <DialogFooter>
              <Button type="submit" disabled={isSubmitting || note.trim() === ''}>
                {isSubmitting
                  ? 'Saving…'
                  : outcome === 'resolved'
                    ? `Mark ${count} resolved`
                    : `Dismiss ${count} ${noun}`}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
