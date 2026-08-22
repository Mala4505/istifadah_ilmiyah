'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { resolveFlag, type ResolveFlagOutcome } from '@/lib/actions/flags'

/**
 * Resolve a `flags` row from the entry page's Issues card (§3.3). Visually
 * modelled on `components/exceptions/resolve-exception-dialog.tsx`, but
 * deliberately simpler: `flags` has no `resolution_note` column
 * (20260808000025/20260814000003), so there is nothing to require a note
 * for — this is a confirm/dismiss choice, not a bookkeeping form.
 */
export function ResolveFlagDialog({
  flagId,
  entryId,
  amountAtRisk,
  description,
}: {
  flagId: number
  entryId: number
  amountAtRisk: number | null
  description: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [isSubmitting, setIsSubmitting] = React.useState<ResolveFlagOutcome | null>(null)

  async function handleChoose(outcome: ResolveFlagOutcome) {
    setIsSubmitting(outcome)
    try {
      const result = await resolveFlag({ flagId, entryId, outcome })
      if (!result.ok) {
        toastError(result.error, { title: 'Could not update flag', context: 'resolve-flag-dialog' })
        return
      }
      toast.success(outcome === 'confirmed' ? 'Flag confirmed' : 'Flag dismissed')
      setOpen(false)
      router.refresh()
    } finally {
      setIsSubmitting(null)
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
        <DialogHeader>
          <DialogTitle>Resolve flag</DialogTitle>
          <DialogDescription>
            {description ?? 'This flag'}
            {amountAtRisk !== null && (
              <>
                {' '}
                · ₹{new Intl.NumberFormat('en-IN').format(amountAtRisk)} at risk
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          Confirm if this flag is a real issue that needs follow-up elsewhere. Dismiss if it doesn&rsquo;t apply.
        </p>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting !== null}
            onClick={() => handleChoose('dismissed')}
          >
            {isSubmitting === 'dismissed' ? 'Dismissing…' : 'Dismiss'}
          </Button>
          <Button type="button" disabled={isSubmitting !== null} onClick={() => handleChoose('confirmed')}>
            {isSubmitting === 'confirmed' ? 'Confirming…' : 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
