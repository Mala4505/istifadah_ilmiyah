import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'

/**
 * Next.js loading convention (house style: app/(app)/settings/loading.tsx).
 * Shown while app/(app)/settings/budgets/page.tsx re-renders
 * (force-dynamic). Mirrors the sub-route header (back link + title) and a
 * generic card-with-table body.
 */
export default function SettingsBudgetsLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-7 w-56" />
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <Skeleton className="h-4 w-40" />
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
