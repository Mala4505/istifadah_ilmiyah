import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

/** Loading state for app/(app)/account/page.tsx (house style: shortcuts/loading.tsx). */
export default function AccountLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-7 w-32" />
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-36" />
          <Skeleton className="mt-1.5 h-3 w-full max-w-md" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full max-w-sm" />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
