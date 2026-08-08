'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
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

/**
 * Resolve or dismiss one exception (§5 row 8, §3.10). The note is required
 * before either action can submit — enforced here in the UI (disabled
 * submit) AND in the server action (rejects an empty note independently),
 * so this is defense in depth, not the only gate.
 */
export function ResolveExceptionDialog({
  exceptionId,
  amountAtRisk,
  description,
}: {
  exceptionId: number
  amountAtRisk: number | null
  description: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [note, setNote] = React.useState('')
  const [outcome, setOutcome] = React.useState<ResolveExceptionOutcome>('resolved')
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (note.trim() === '') return
    setIsSubmitting(true)
    try {
      const result = await resolveException({ exceptionId, outcome, note })
      if (!result.ok) {
        toast.error('Could not update exception', { description: result.error })
        return
      }
      toast.success(outcome === 'resolved' ? 'Exception resolved' : 'Exception dismissed')
      setOpen(false)
      setNote('')
      router.refresh()
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Resolve
        </Button>
      </DialogTrigger>
      <DialogContent>
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
      </DialogContent>
    </Dialog>
  )
}
