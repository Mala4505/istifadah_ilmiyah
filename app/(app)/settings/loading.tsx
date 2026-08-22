import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'

/**
 * Next.js's built-in loading convention (house style: documents/loading.tsx,
 * review/loading.tsx). Shown while the server re-renders
 * app/(app)/settings/page.tsx (force-dynamic, folds Events/Upload
 * limits/Users & Roles/Budget Heads/Vendors/Master Data into tabs) --
 * docs/pre-deploy-findings-and-plan.md §8.2. Mirrors the header, the tab
 * strip, and a generic card-with-table body for whichever tab loads first.
 */
export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-7 w-24" />

      <div className="flex flex-wrap gap-1 border-b border-border pb-px">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-t-md" />
        ))}
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
