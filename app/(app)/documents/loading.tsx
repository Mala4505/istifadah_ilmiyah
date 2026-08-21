import { Skeleton } from '@/components/ui/skeleton'

/**
 * Next.js's built-in loading convention (app/(app)/review/loading.tsx is the
 * house style this mirrors) -- automatically shown while the server renders
 * app/(app)/documents/page.tsx (checklist 2.8, D6). Previously there was no
 * loading.tsx for this route at all, so first load (and any full navigation
 * back to /documents) showed a blank screen for the length of six RSC
 * queries. Static markup only, like review/loading.tsx -- this file does not
 * import from document-card.tsx or upload-dropzone.tsx, it just mirrors
 * their proportions by eye.
 *
 * Shape mirrored, top to bottom:
 *  - the page header row (title + "N unmatched documents" count), see
 *    PageShell in page.tsx
 *  - the upload dropzone's dashed drop-zone box (upload-dropzone.tsx's
 *    outer `border-2 border-dashed ... py-8 sm:py-10` block)
 *  - a handful of document-card-shaped blocks (document-card.tsx's Card):
 *    a header row (filename + stage tracker), a secondary action row, then
 *    a field grid and a couple of button-shaped placeholders.
 */
export default function DocumentsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-36" />
      </div>

      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border px-4 py-8 sm:py-10">
        <Skeleton className="h-8 w-8 rounded-full" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-3 w-72" />
        <Skeleton className="mt-1 h-8 w-28 rounded-md" />
      </div>

      <div className="flex flex-col gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <DocumentCardSkeleton key={i} />
        ))}
      </div>
    </div>
  )
}

function DocumentCardSkeleton() {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-3 px-6 pt-6">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-3 w-40" />
        </div>
        <div className="flex flex-col items-end gap-1">
          <Skeleton className="h-3.5 w-48" />
          <Skeleton className="h-2.5 w-24" />
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-border px-6 py-2.5">
        <Skeleton className="h-7 w-32 rounded-md" />
        <Skeleton className="h-7 w-24 rounded-md" />
      </div>

      <div className="flex flex-col gap-4 px-6 pb-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1">
              <Skeleton className="h-2.5 w-14" />
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <Skeleton className="h-8 w-40 rounded-md" />
          <Skeleton className="h-4 w-28" />
        </div>
      </div>
    </div>
  )
}
