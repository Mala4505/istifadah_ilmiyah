import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'

/**
 * Next.js's built-in loading convention (house style: settings/loading.tsx,
 * settings/users/loading.tsx). Shown while
 * app/(app)/settings/master-data/page.tsx (force-dynamic) re-renders its
 * per-department master rows and the Hub-status lifecycle table server-side.
 */
export default function SettingsMasterDataLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-7 w-40" />

      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
