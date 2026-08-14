import { Skeleton } from '@/components/ui/skeleton'

/**
 * Next.js's built-in loading convention (app/(app)/review/loading.tsx) --
 * automatically shown while the server re-renders app/(app)/review/page.tsx
 * for a new `?id=`. Every `J`/`K`/PgUp/PgDn navigation is a full RSC round
 * trip (see the header comment on page.tsx), which previously left the
 * screen blank for that stretch. Mirrors the real layout -- PageHeader row,
 * the ReviewWorkspace toolbar row, and its `grid grid-cols-2` split pane
 * (see the `<div className="grid min-h-0 flex-1 grid-cols-2 gap-3">` block
 * in components/review/review-workspace.tsx) -- so the transition reads as
 * "the same screen, loading" rather than a flash of empty content.
 */
export default function ReviewLoading() {
  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-5 w-24 rounded-full" />
        <Skeleton className="h-4 w-28" />
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-28" />
        <Skeleton className="ml-auto h-8 w-24" />
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-28" />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-md border border-border bg-muted/30">
          <div className="flex items-center gap-1 border-b border-border bg-background px-2 py-1.5">
            <Skeleton className="h-7 w-7" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-7 w-7" />
          </div>
          <div className="flex flex-1 items-center justify-center p-3">
            <Skeleton className="h-full max-h-full w-full max-w-md" style={{ aspectRatio: '1 / 1.414' }} />
          </div>
        </div>

        <div className="flex h-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-1">
          <div className="grid grid-cols-2 gap-3 rounded-md border border-border p-3">
            <div className="col-span-2 flex flex-col gap-1.5">
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-9 w-full" />
            </div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-40 w-full rounded-md" />
          </div>
        </div>
      </div>

      <Skeleton className="h-11 w-full rounded-md" />
    </div>
  )
}
