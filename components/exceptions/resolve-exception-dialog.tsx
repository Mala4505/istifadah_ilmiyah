'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
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
  DialogTrigger,
} from '@/components/ui/dialog'
import { resolveException, type ResolveExceptionOutcome } from '@/lib/actions/exceptions'
import { getExceptionAction } from '@/components/exceptions/what-to-do'

/**
 * Resolve or dismiss one exception (§5 row 8, §3.10). The note is required
 * before either action can submit — enforced here in the UI (disabled
 * submit) AND in the server action (rejects an empty note independently),
 * so this is defense in depth, not the only gate.
 *
 * §4.1: beyond bookkeeping, this now surfaces a per-type "what to do" hint
 * and (where a real destination exists) a link to the thing that actually
 * needs fixing — see components/exceptions/what-to-do.ts for the mapping
 * and the reasoning behind each destination/fallback.
 */
export function ResolveExceptionDialog({
  exceptionId,
  amountAtRisk,
  description,
  exceptionType = '',
  entryId = null,
  documentExtractionId = null,
  sourceDocumentId = null,
}: {
  exceptionId: number
  amountAtRisk: number | null
  description: string | null
  /**
   * Optional (default ''), not because the hint is meaningless without it —
   * every caller should pass the real type — but because other in-flight
   * work adds call sites of this dialog (e.g. an entry-page Issues card)
   * that may not thread every id through on day one. An unset type just
   * falls through to the generic "review the description" hint below
   * rather than failing to compile.
   */
  exceptionType?: string
  entryId?: number | null
  documentExtractionId?: number | null
  sourceDocumentId?: number | null
}) {
  const action = getExceptionAction({
    exception_type: exceptionType,
    entry_id: entryId,
    document_extraction_id: documentExtractionId,
    source_document_id: sourceDocumentId,
  })
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [note, setNote] = React.useState('')
  const [outcome, setOutcome] = React.useState<ResolveExceptionOutcome>('resolved')
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  // §4.8: guard against silently discarding a typed note, and confirm a
  // dismiss specifically (there is no reopen action anywhere).
  const [confirmStep, setConfirmStep] = React.useState<null | 'discard' | 'dismiss'>(null)

  function reset() {
    setNote('')
    setOutcome('resolved')
    setConfirmStep(null)
  }

  function requestOpenChange(next: boolean) {
    if (next) {
      setOpen(true)
      return
    }
    if (isSubmitting) return
    if (note.trim() !== '' && confirmStep === null) {
      setConfirmStep('discard')
      return
    }
    reset()
    setOpen(false)
  }

  async function runSubmit() {
    setIsSubmitting(true)
    try {
      const result = await resolveException({ exceptionId, outcome, note })
      if (!result.ok) {
        toastError(result.error, { title: 'Could not update exception', context: 'resolve-exception-dialog' })
        return
      }
      toast.success(outcome === 'resolved' ? 'Exception resolved' : 'Exception dismissed')
      reset()
      setOpen(false)
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
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Resolve
        </Button>
      </DialogTrigger>
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
                  setOpen(false)
                }}
              >
                Discard
              </Button>
            </DialogFooter>
          </div>
        ) : confirmStep === 'dismiss' ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Dismiss this exception?</DialogTitle>
              <DialogDescription>
                A dismissed exception stays in the audit trail but can&rsquo;t be reopened.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirmStep(null)} disabled={isSubmitting}>
                Back
              </Button>
              <Button type="button" variant="destructive" onClick={() => void runSubmit()} disabled={isSubmitting}>
                {isSubmitting ? 'Dismissing…' : 'Dismiss exception'}
              </Button>
            </DialogFooter>
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Resolve exception</DialogTitle>
            <DialogDescription>
              {description ?? 'This exception'}
              {amountAtRisk !== null && (
                <>
                  {' '}
                  · ₹{new Intl.NumberFormat('en-IN').format(amountAtRisk)} at risk
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
            <p className="text-sm">
              <span className="font-medium">What to do: </span>
              {action.whatToDo}
            </p>
            {action.destination && (
              <Button asChild size="sm" variant="secondary" className="w-fit">
                <Link href={action.destination.href}>
                  {action.destination.label}
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </Button>
            )}
          </div>

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
            <Label htmlFor="resolution-note">
              Resolution note <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="resolution-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What did you check, and why is this OK to close?"
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
              {isSubmitting ? 'Saving…' : outcome === 'resolved' ? 'Mark resolved' : 'Dismiss'}
            </Button>
          </DialogFooter>
        </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
