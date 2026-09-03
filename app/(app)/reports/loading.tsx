import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

/**
 * Next.js's built-in loading convention (house style: documents/loading.tsx,
 * review/loading.tsx, entries/[id]/loading.tsx). Shown while the server runs
 * the three per-surface loaders (lib/reports/surfaces/*.ts) + loadHeroMetrics
 * behind the Explore route -- every section is a fresh aggregate-view query,
 * force-dynamic, so a nav click or event switch leaves the previous page
 * frozen for the round trip (docs/pre-deploy-findings-and-plan.md §8.2,
 * explicitly a priority route). Mirrors the real shape: the h1 + event badge,
 * the description paragraph, the anchor-link nav row (`SECTIONS.map`), then a
 * handful of ReportSection-shaped cards -- Explore carries eleven sections;
 * this shows four so the skeleton stays lightweight while still reading as "a
 * stack of report cards is coming."
 *
 * The sticky period bar and the surface-tab nav (app/(app)/reports/layout.tsx)
 * are part of this same route segment, so this fallback replaces them too
 * while the layout's own event/profile queries are in flight -- the Skeleton
 * rows up top stand in, same height and sticky positioning, so nothing jumps
 * when the real chrome mounts.
 */
export default function ReportsLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-0 z-20 -mx-3 -mt-3 mb-4 flex items-center justify-between gap-6 border-b border-border bg-background px-3 py-3 sm:-mx-6 sm:-mt-6 sm:px-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-9 w-44" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-5 w-28 rounded-full" />
      </div>
      <Skeleton className="h-4 w-full max-w-2xl" />
      <Skeleton className="h-4 w-2/3 max-w-2xl" />

      {/* surface-tab nav (layout) */}
      <div className="flex flex-wrap gap-1 border-b border-border pb-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-28 rounded-md" />
        ))}
      </div>

      {/* in-page section anchors */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border pb-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-24" />
        ))}
      </div>

      {Array.from({ length: 4 }).map((_, i) => (
        <ReportSectionSkeleton key={i} />
      ))}
    </div>
  )
}

function ReportSectionSkeleton() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-64" />
        </div>
        <Skeleton className="h-8 w-24 rounded-md" />
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-0">
        <div className="flex items-center gap-4 border-b border-border pb-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-3 flex-1" />
          ))}
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 py-1">
            {Array.from({ length: 5 }).map((_, j) => (
              <Skeleton key={j} className="h-3.5 flex-1" />
            ))}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
