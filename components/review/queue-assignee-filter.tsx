'use client'

/**
 * Superadmin-only reviewer filter for the /review queue (document-assignment,
 * 2026-08-29). Sits next to QueueScopeToggle. Persists via
 * setReviewQueueAssignee's httpOnly cookie, then router.refresh() so
 * app/(app)/review/page.tsx re-reads the cookie and re-filters the queue rows
 * server-side -- same action-then-refresh shape as
 * components/review/queue-scope-toggle.tsx.
 */

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toastError } from '@/components/ui/error-toast'
import { setReviewQueueAssignee } from '@/lib/actions/review'

export function QueueAssigneeFilter({
  reviewers,
  current,
}: {
  reviewers: { id: string; displayName: string }[]
  current: string | null
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function select(value: string) {
    const next = value === '' ? null : value
    if (next === current || isPending) return
    startTransition(async () => {
      const result = await setReviewQueueAssignee(next)
      if (!result.ok) {
        toastError('Could not change the reviewer filter.', {
          title: 'Reviewer filter change failed',
          context: 'queue-assignee-filter',
        })
        return
      }
      router.refresh()
    })
  }

  return (
    <label className="inline-flex items-center rounded-md border border-border p-0.5 text-xs">
      <span className="sr-only">Filter the queue by reviewer</span>
      <select
        value={current ?? ''}
        onChange={(e) => select(e.target.value)}
        disabled={isPending}
        className="rounded bg-transparent px-2 py-1 font-medium text-muted-foreground transition-colors focus:outline-none disabled:opacity-60"
      >
        <option value="">All reviewers</option>
        {reviewers.map((r) => (
          <option key={r.id} value={r.id}>
            {r.displayName}
          </option>
        ))}
      </select>
    </label>
  )
}
