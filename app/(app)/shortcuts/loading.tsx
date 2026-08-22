import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

/**
 * Next.js's built-in loading convention (house style: documents/loading.tsx,
 * review/loading.tsx). Shown while the server re-renders
 * app/(app)/shortcuts/page.tsx (force-dynamic, loads the staff keymap
 * preferences) -- docs/pre-deploy-findings-and-plan.md §8.2. Mirrors the
 * header and the single "Keyboard shortcuts" card that lists each
 * configurable binding.
 */
export default function ShortcutsLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-7 w-28" />
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-44" />
          <Skeleton className="mt-1.5 h-3 w-full max-w-lg" />
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-4">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-7 w-24 rounded-md" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
