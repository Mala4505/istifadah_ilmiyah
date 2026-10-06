import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'

/** Loading state for /settings/item-catalog (house style: settings/vendors/loading.tsx). */
export default function SettingsItemCatalogLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-7 w-36" />
      </div>
      {[0, 1].map((card) => (
        <Card key={card}>
          <CardContent className="flex flex-col gap-3 pt-6">
            <Skeleton className="h-4 w-48" />
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
