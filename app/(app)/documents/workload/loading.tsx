import { Skeleton } from '@/components/ui/skeleton'

/**
 * Next.js's built-in loading convention (house style: documents/loading.tsx,
 * accuracy/loading.tsx) — shown while the server renders
 * app/(app)/documents/workload/page.tsx (force-dynamic). Mirrors the board:
 * the page header row, then a grid of per-admin column cards.
 */
export default function WorkloadLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-28" />
      </div>

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
    </div>
  )
}
