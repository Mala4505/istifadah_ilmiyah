import { Skeleton } from '@/components/ui/skeleton'

/**
 * Suspense fallback for the workload view of /documents (redesign plan Phase
 * 1.2) -- shown while `getAssignmentWorkload` runs. Mirrors WorkloadBoard: a
 * grid of per-admin column cards. Moved here from the old
 * app/(app)/documents/workload/loading.tsx when that route became a redirect.
 */
export function WorkloadBoardSkeleton() {
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-2 pb-1">
            <Skeleton className="h-6 w-6 rounded-full" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="ml-auto h-4 w-6" />
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="mt-1 h-1.5 w-full rounded-full" />
        </div>
      ))}
    </div>
  )
}
