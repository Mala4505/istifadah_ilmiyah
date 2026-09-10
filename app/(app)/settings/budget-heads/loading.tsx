import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'

/**
 * Next.js's built-in loading convention (house style: settings/loading.tsx,
 * documents/loading.tsx). Shown while the server renders
 * app/(app)/settings/budget-heads/page.tsx (force-dynamic). Mirrors the
 * sub-route header (back link + title) and a generic card-with-rows body.
 */
export default function BudgetHeadsSettingsLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-7 w-40" />
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <Skeleton className="h-4 w-64" />
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
