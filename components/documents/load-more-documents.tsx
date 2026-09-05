'use client'

/**
 * "Load more" for the /documents inbox's server-side fetch limit
 * (performance remediation plan 7.5). Mirrors assignment-scope.tsx's shape
 * exactly: a plain URL param (`docsLimit`) that app/(app)/documents/page.tsx
 * re-reads to widen its own `.range()`, pushed via useTransition so the
 * control shows a pending state while the real navigation re-runs the whole
 * document-inbox query pipeline (docs, assignees, extractions, admin heads,
 * zones) for the larger window.
 *
 * This has to be a real navigation, not a client-side trick: an older
 * unmatched document that fell outside the default window doesn't exist
 * anywhere in this page's current props, and the RLS-scoped source_document
 * query that would find it can only run on the server. `useSearchParams()`
 * is what requires the <Suspense> boundary this is rendered inside
 * (page.tsx) — matches the codebase's one other useSearchParams() consumer,
 * components/entries/entries-explorer.tsx, which is Suspense-wrapped for
 * the same reason.
 */

import { useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

export function LoadMoreDocuments({ currentLimit, increment }: { currentLimit: number; increment: number }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  function handleClick() {
    // Cloning the current params (rather than building from scratch)
    // preserves scope/assignee, and rides along with whatever filter/sort
    // state document-table.tsx has written into the URL (7.4) — this
    // component doesn't need to know those param names to keep them intact.
    const params = new URLSearchParams(searchParams.toString())
    params.set('docsLimit', String(currentLimit + increment))
    startTransition(() => {
      router.push(`/documents?${params.toString()}`, { scroll: false })
    })
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      className="font-medium text-primary hover:underline disabled:opacity-60"
    >
      {isPending ? 'Loading…' : `Load ${increment} more`}
    </button>
  )
}
