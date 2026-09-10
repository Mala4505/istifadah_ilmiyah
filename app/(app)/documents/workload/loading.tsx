import { Skeleton } from '@/components/ui/skeleton'

/**
 * app/(app)/documents/workload/page.tsx is now a bare server-side
 * `redirect('/documents?view=workload')` (redesign plan Phase 1.2) with no
 * rendered content of its own -- this exists only so the brief hop through
 * this route during the redirect doesn't flash a blank screen. Kept minimal
 * since there is no real page shape to mirror (pattern:
 * app/(app)/import/bookmarklet/loading.tsx).
 */
export default function DocumentsWorkloadRedirectLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-24 w-full rounded-md" />
    </div>
  )
}
