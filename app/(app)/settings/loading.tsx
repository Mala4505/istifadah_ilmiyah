import { Skeleton } from '@/components/ui/skeleton'

/**
 * Next.js's built-in loading convention (house style: documents/loading.tsx,
 * review/loading.tsx). Shown while app/(app)/settings/page.tsx re-renders
 * (force-dynamic). Post Phase 2 redesign the page is one plain grouped
 * row-list -- no tab strip -- so this mirrors three groups of rows.
 */
export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-7 w-24" />

      <div className="flex flex-col gap-6">
        {Array.from({ length: 3 }).map((_, group) => (
          <div key={group} className="flex flex-col gap-1">
            <Skeleton className="h-3 w-24" />
            <div className="rounded-lg border border-border">
              {Array.from({ length: 2 }).map((_, row) => (
                <div key={row} className="flex flex-col gap-1.5 border-b border-border px-4 py-3 last:border-b-0">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
