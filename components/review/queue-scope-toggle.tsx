'use client'

/**
 * Unverified/All toggle for the /review queue (review-page-layout-redesign-plan.md
 * §1). Persists via setReviewQueueScope's httpOnly cookie, then router.refresh()
 * so app/(app)/review/page.tsx re-reads the cookie and swaps
 * v_review_queue/v_review_queue_all server-side -- same
 * action-then-refresh shape as components/review/hub-status-dialog.tsx and
 * components/exceptions/resolve-exception-dialog.tsx.
 */

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toastError } from '@/components/ui/error-toast'
import { setReviewQueueScope } from '@/lib/actions/review'
import { cn } from '@/lib/utils'

export function QueueScopeToggle({ current }: { current: 'pending' | 'all' }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function select(scope: 'pending' | 'all') {
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
          ['pending', 'Unverified'],
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
