import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

/**
 * Next.js's built-in loading convention (house style: documents/loading.tsx,
 * review/loading.tsx). Shown while the server re-runs `loadAccuracyData` in
 * app/(app)/accuracy/page.tsx (force-dynamic) -- docs/pre-deploy-findings-
 * and-plan.md §8.2. Mirrors the page's own ReportSection-shaped cards (same
 * pattern as /reports, components/reports/report-section.tsx).
 */
export default function AccuracyLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-7 w-28" />
      <Skeleton className="h-4 w-full max-w-2xl" />

      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-64" />
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 pt-0">
            <div className="flex items-center gap-4 border-b border-border pb-2">
              {Array.from({ length: 4 }).map((_, j) => (
                <Skeleton key={j} className="h-3 flex-1" />
              ))}
            </div>
            {Array.from({ length: 3 }).map((_, j) => (
              <div key={j} className="flex items-center gap-4 py-1">
                {Array.from({ length: 4 }).map((_, k) => (
                  <Skeleton key={k} className="h-3.5 flex-1" />
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
