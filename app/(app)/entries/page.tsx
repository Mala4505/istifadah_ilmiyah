import { Suspense } from 'react'
import { EntriesExplorer } from '@/components/entries/entries-explorer'
import { Skeleton } from '@/components/ui/skeleton'

// Screen 3 — Entries list (MASTER-PLAN §5 row 3, §11.1 Day 3). Reads from
// `v_entry_enriched` (§10.2) rather than assembling joins here. Filter state
// lives in the URL via useSearchParams, which is why the interactive part is
// a Client Component wrapped in Suspense — useSearchParams opts a subtree
// out of static rendering and Next requires a Suspense boundary around it.
export default function EntriesPage() {
  return (
    <Suspense fallback={<EntriesPageSkeleton />}>
      <EntriesExplorer />
    </Suspense>
  )
}

function EntriesPageSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-8 w-40" />
      </div>
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  )
}
