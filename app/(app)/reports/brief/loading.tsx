import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

// Mirrors app/(app)/reports/loading.tsx's shape (force-dynamic page,
// re-queried on every nav/event switch) for the Executive Brief route: the
// h1 + event badge + present-mode header row, the 5-tile KPI band, then a
// handful of ReportSection-shaped cards for the sentence band, two charts
// and two panels.
export default function ExecutiveBriefLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-5 w-28 rounded-full" />
        </div>
        <Skeleton className="h-8 w-28 rounded-md" />
      </div>
      <Skeleton className="h-4 w-full max-w-2xl" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-md" />
        ))}
      </div>

      <BriefSectionSkeleton lines={4} />

      <div className="grid gap-4 lg:grid-cols-2">
        <BriefSectionSkeleton chart />
        <BriefSectionSkeleton chart />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <BriefSectionSkeleton lines={6} />
        <BriefSectionSkeleton lines={6} />
      </div>
    </div>
  )
}

function BriefSectionSkeleton({ lines = 0, chart = false }: { lines?: number; chart?: boolean }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-0">
        {chart && <Skeleton className="h-48 w-full" />}
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className="h-3.5 w-full" />
        ))}
      </CardContent>
    </Card>
  )
}
