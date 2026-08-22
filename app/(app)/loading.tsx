import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

/**
 * Next.js's built-in loading convention (house style: documents/loading.tsx,
 * review/loading.tsx). Shown while the server re-renders app/(app)/page.tsx
 * (the Dashboard, force-dynamic) -- docs/pre-deploy-findings-and-plan.md
 * §8.2. Mirrors the real shape top to bottom: the h1 + description, the
 * five-tile stat grid (StatTile), the three-card status-breakdown row
 * (StatusCountCard), and the two-column "getting data in" cards.
 */
export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Skeleton className="h-7 w-32" />
        <Skeleton className="mt-2 h-4 w-full max-w-2xl" />
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex flex-col gap-2 pt-6">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-7 w-20" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-36" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {Array.from({ length: 4 }).map((_, j) => (
                  <Skeleton key={j} className="h-6 w-full rounded-full" />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-56" />
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-1.5 h-3 w-full" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-32 rounded-md" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
