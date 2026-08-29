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
 * mirrors the real shape: the page header, the *collapsed* filter bar
 * (filter-bar.tsx opens collapsed at ~40px — docs/hub-screen-certification.md
 * §4.5, so painting the expanded 4-section panel here just collapses on
 * hydration and shoves the table up), and the entries table's header row
 * plus a handful of body rows (entries-table.tsx).
 */
export default function EntriesLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-8 w-40" />
      </div>

      <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card p-2.5">
        <Skeleton className="h-5 w-40" />
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
