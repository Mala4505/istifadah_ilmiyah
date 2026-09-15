'use client'

/**
 * "Needs work"/"Reviewed"/"All" toggle for the /review queue (review-page-
 * layout-redesign-plan.md §1; "Reviewed" added 2026-09-15). Persists via
 * setReviewQueueScope's httpOnly cookie, then router.refresh() so
 * app/(app)/review/page.tsx re-reads the cookie and swaps
 * v_review_queue/v_review_queue_all (with a reviewed-only filter for
 * "Reviewed") server-side -- same action-then-refresh shape as
 * components/review/hub-status-dialog.tsx and
 * components/exceptions/resolve-exception-dialog.tsx.
 *
 * The default ('pending') view is v_review_queue, which since 20260907000002
 * is "not finished" rather than strictly "not verified" -- it keeps a bill
 * until its extraction is verified AND it's connected to a ledger entry AND
 * that entry is classified. "Reviewed" is the mirror image of that same
 * predicate, so a bill lands in exactly one of "Needs work"/"Reviewed" (and
 * both together make up "All").
 */

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toastError } from '@/components/ui/error-toast'
import { setReviewQueueScope } from '@/lib/actions/review'
import { cn } from '@/lib/utils'

export function QueueScopeToggle({ current }: { current: 'pending' | 'reviewed' | 'all' }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function select(scope: 'pending' | 'reviewed' | 'all') {
    if (scope === current || isPending) return
    startTransition(async () => {
      const result = await setReviewQueueScope(scope)
      if (!result.ok) {
        toastError('Could not change the queue scope.', { title: 'Scope change failed', context: 'queue-scope-toggle' })
        return
      }
      router.refresh()
    })
  }

  return (
    <div className="inline-flex items-center rounded-md border border-border p-0.5 text-xs">
      {(
        [
          ['pending', 'Needs work'],
          ['reviewed', 'Reviewed'],
          ['all', 'All'],
        ] as const
      ).map(([scope, label]) => (
        <button
          key={scope}
          type="button"
          onClick={() => select(scope)}
          disabled={isPending}
          aria-pressed={current === scope}
          className={cn(
            'rounded px-2 py-1 font-medium transition-colors',
            current === scope
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted disabled:opacity-60'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
