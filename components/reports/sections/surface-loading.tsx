import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

/**
 * Shared loading fallback for the split Reports surfaces (Budget & Spend,
 * Vendors & Purchases, Integrity -- reporting-blueprint.md §8 Phase Three).
 * Each surface route is force-dynamic and re-queries its views on every nav
 * click or event switch, so it needs a `loading.tsx`; they differ only in
 * heading width and section count. The sticky period bar and surface nav are
 * in the layout segment, so this fallback replaces them too while the
 * layout's own queries are in flight -- the two rows up top stand in.
 */
export function SurfaceLoading({ headingWidth = 'w-40', sections = 3 }: { headingWidth?: string; sections?: number }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className={`h-7 ${headingWidth}`} />
          <Skeleton className="h-5 w-28 rounded-full" />
        </div>
        <Skeleton className="h-4 w-40" />
      </div>
      <Skeleton className="h-4 w-full max-w-2xl" />
      <Skeleton className="h-4 w-2/3 max-w-2xl" />

      {Array.from({ length: sections }).map((_, i) => (
        <SectionSkeleton key={i} />
      ))}
    </div>
  )
}

/**
 * Perf remediation Phase 6.1 (docs/performance-remediation-plan.md): also
 * used directly as a per-section `<Suspense>` fallback now that each Reports
 * route awaits its loaders individually instead of one page-wide
 * `Promise.all` -- same card shape, so nothing jumps when the real section
 * mounts in its place.
 */
export function SectionSkeleton() {
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
        <Skeleton className="h-16 w-44 rounded-md" />
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
