import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

/**
 * Next.js's built-in loading convention (house style: documents/loading.tsx,
 * review/loading.tsx). Shown while the server re-renders
 * app/(app)/export/page.tsx (admin-gated) -- docs/pre-deploy-findings-and-
 * plan.md §8.2. Mirrors the header, the "Generate a batch" card, the
 * pending-queue table card, and the batch-history section.
 */
export default function ExportLoading() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-7 w-24" />
      <Skeleton className="h-4 w-full max-w-2xl" />
      <Skeleton className="h-4 w-2/3 max-w-2xl" />

      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-36" />
          <Skeleton className="mt-1.5 h-3 w-full max-w-md" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-9 w-40 rounded-md" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-1.5 h-3 w-40" />
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-full max-w-lg" />
        <Skeleton className="h-24 w-full rounded-md" />
      </div>
    </div>
  )
}
