import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'

/** Loading state for app/(app)/tags/[id]/page.tsx: back link, title, and three table cards. */
export default function TagDetailLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-7 w-64" />
      </div>
      {Array.from({ length: 3 }).map((_, card) => (
        <Card key={card}>
          <CardContent className="flex flex-col gap-3 pt-6">
            <Skeleton className="h-4 w-40" />
            {Array.from({ length: 3 }).map((__, row) => (
              <Skeleton key={row} className="h-8 w-full" />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
