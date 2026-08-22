import { Skeleton } from '@/components/ui/skeleton'

/**
 * Next.js's built-in loading convention (house style: documents/loading.tsx,
 * review/loading.tsx). Shown while the server re-renders
 * app/(app)/exceptions/page.tsx (force-dynamic) -- docs/pre-deploy-findings-
 * and-plan.md §8.2. Mirrors PageShell's header, the two-tab strip (Queue /
 * Reconciliation report, ui/tabs), the filter row, and a handful of
 * exceptions-table-shaped rows.
 */
export default function ExceptionsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-7 w-28" />
      </div>
      <Skeleton className="h-4 w-full max-w-2xl" />
      <Skeleton className="h-3 w-2/3 max-w-2xl" />

      <div className="flex gap-1 border-b border-border pb-px">
        <Skeleton className="h-8 w-16 rounded-t-md" />
        <Skeleton className="h-8 w-40 rounded-t-md" />
      </div>

      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-32 rounded-md" />
        <Skeleton className="h-8 w-32 rounded-md" />
      </div>

      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 rounded-md border border-border px-3 py-3">
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  )
}
