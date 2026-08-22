import { Skeleton } from '@/components/ui/skeleton'

/**
 * Next.js's built-in loading convention (house style: documents/loading.tsx,
 * review/loading.tsx). Shown while the server re-renders
 * app/(app)/import/page.tsx (force-dynamic, also reads the bookmarklet
 * source file off disk) -- docs/pre-deploy-findings-and-plan.md §8.2.
 * Mirrors the header plus the upload card / Portal Reader card / batch
 * history stack that ImportPageClient renders.
 */
export default function ImportLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-7 w-24" />

      <div className="rounded-lg border border-border p-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-24 w-full rounded-md" />
      </div>

      <div className="rounded-lg border border-border p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-3 h-9 w-48 rounded-md" />
      </div>

      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-36" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    </div>
  )
}
