import { Skeleton } from '@/components/ui/skeleton'

/**
 * Next.js's built-in loading convention (house style: documents/loading.tsx,
 * review/loading.tsx). app/(app)/import/bookmarklet/page.tsx is a bare
 * server-side `redirect('/import')` with no rendered content of its own
 * (the Portal Reader moved onto /import itself) -- this exists only so the
 * brief hop through this route during the redirect doesn't show a blank
 * screen, per docs/pre-deploy-findings-and-plan.md §8.2's route inventory.
 * Kept intentionally minimal since there is no real page shape to mirror.
 */
export default function BookmarkletRedirectLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-7 w-24" />
      <Skeleton className="h-24 w-full rounded-md" />
    </div>
  )
}
