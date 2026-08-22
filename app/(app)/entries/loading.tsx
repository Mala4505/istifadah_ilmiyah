import { Skeleton } from '@/components/ui/skeleton'

/**
 * Next.js's built-in loading convention (house style: documents/loading.tsx,
 * review/loading.tsx, entries/[id]/loading.tsx) -- shown while the server
 * renders app/(app)/entries/page.tsx itself, i.e. the outer navigation to
 * /entries (a click from the nav rail, or a full reload). This is distinct
 * from the `EntriesPageSkeleton` already inlined in page.tsx as the
 * Suspense fallback around `<EntriesExplorer />` -- that one covers the
 * client-side useSearchParams hydration gap *after* this shell has already
 * painted; this one covers the gap *before* anything has painted at all.
 * Priority route per docs/pre-deploy-findings-and-plan.md §8.2, so this
 * mirrors more of the real shape than a generic skeleton would: the page
 * header, the four labelled filter-bar sections (filter-bar.tsx's Status /
 * Classification / Search / Flags groups), and the entries table's header
 * row plus a handful of body rows (entries-table.tsx).
 */
export default function EntriesLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-8 w-40" />
      </div>

      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-3">
        <FilterSectionSkeleton fieldCount={3} />
        <FilterSectionSkeleton fieldCount={5} />
        <FilterSectionSkeleton fieldCount={3} />
        <FilterSectionSkeleton fieldCount={3} />
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-4 border-b border-border bg-muted/40 px-3 py-2">
          <Skeleton className="h-4 w-4" />
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-3.5 flex-1" />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-border px-3 py-3 last:border-b-0">
            <Skeleton className="h-4 w-4" />
            {Array.from({ length: 7 }).map((_, j) => (
              <Skeleton key={j} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function FilterSectionSkeleton({ fieldCount }: { fieldCount: number }) {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-3 w-20" />
      <div className="flex flex-wrap gap-3">
        {Array.from({ length: fieldCount }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-8 w-36 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  )
}
