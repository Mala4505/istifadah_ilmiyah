import { Skeleton } from '@/components/ui/skeleton'

/**
 * Next.js's built-in loading convention (app/(app)/review/loading.tsx is the
 * house style this mirrors) -- automatically shown while the server renders
 * app/(app)/documents/page.tsx (checklist 2.8, D6). Previously first load (and
 * any full navigation back to /documents) showed a blank screen for the
 * length of the RSC queries.
 *
 * Shape mirrored, top to bottom (kept in sync with document-inbox.tsx /
 * document-table.tsx by eye; static markup only, no imports from those files):
 *  - the page header row (title + "N unmatched documents" count)
 *  - the compact upload dropzone (single dashed row, once the inbox is non-empty)
 *  - the filter panel (rounded card, a grid of filter fields)
 *  - the documents table (header row + a page of rows)
 *  - the pagination bar row
 */
export default function DocumentsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-36" />
      </div>

      <div className="flex flex-row items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border px-3 py-2.5">
        <Skeleton className="h-4 w-4 rounded-full" />
        <Skeleton className="h-4 w-52" />
        <Skeleton className="h-8 w-24 rounded-md" />
      </div>

      <div className="flex flex-col gap-3">
        {/* Filter panel — matches document-table.tsx's filter card. */}
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-1">
                <Skeleton className="h-2.5 w-14" />
                <Skeleton className="h-9 w-full rounded-md" />
              </div>
            ))}
          </div>
        </div>

        {/* Table — header row + a page of document rows. */}
        <div className="overflow-x-auto rounded-md border border-border">
          <div className="flex items-center gap-4 border-b border-border bg-card px-3 py-2.5">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="ml-auto h-3 w-16" />
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-border px-3 py-3 last:border-0">
              <Skeleton className="h-4 w-4" />
              <div className="flex flex-col gap-1">
                <Skeleton className="h-3.5 w-44" />
                <Skeleton className="h-2.5 w-16" />
              </div>
              <div className="flex flex-col gap-1">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-2.5 w-24" />
              </div>
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-3 w-28" />
              <Skeleton className="ml-auto h-8 w-20 rounded-md" />
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-4 w-52" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-16 rounded-md" />
            <Skeleton className="h-8 w-16 rounded-md" />
          </div>
        </div>
      </div>
    </div>
  )
}
