'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SelectNative } from '@/components/ui/select-native'
import { cn } from '@/lib/utils'
import { PAGE_SIZE_OPTIONS } from '@/components/ui/pagination-bar-options'

export { PAGE_SIZE_OPTIONS }

/**
 * Shared pagination bar for every list screen
 * (docs/hub-screen-certification.md §3.1): "showing X–Y of Z", an optional
 * page-size selector, and prev/next. Purely presentational — it renders the
 * numbers the caller computes and calls back on interaction. This closes the
 * "items per page" row of the certification matrix on Entries, Documents and
 * Exceptions at once, instead of each screen re-deriving it.
 *
 * `total = null` means the count isn't known (or wasn't requested) — the bar
 * then shows "Showing X–Y" with no "of Z" rather than a wrong number.
 */
export function PaginationBar({
  rangeStart,
  rangeEnd,
  total,
  pageSize,
  onPageSizeChange,
  pageSizeOptions = PAGE_SIZE_OPTIONS as unknown as number[],
  canPrev,
  canNext,
  onPrev,
  onNext,
  disabled = false,
  noun = 'row',
  className,
}: {
  rangeStart: number
  rangeEnd: number
  total: number | null
  pageSize: number
  onPageSizeChange?: (size: number) => void
  pageSizeOptions?: number[]
  canPrev: boolean
  canNext: boolean
  onPrev: () => void
  onNext: () => void
  disabled?: boolean
  /** Singular noun for the count, e.g. "entry" → "entries" via +s / special-case. */
  noun?: string
  className?: string
}) {
  const empty = rangeEnd < rangeStart
  const plural = noun === 'entry' ? 'entries' : `${noun}s`

  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <p aria-live="polite">
          {empty ? (
            `No ${plural}`
          ) : total === null ? (
            <>
              Showing <span className="font-medium text-foreground">{rangeStart.toLocaleString('en-IN')}</span>–
              <span className="font-medium text-foreground">{rangeEnd.toLocaleString('en-IN')}</span>
            </>
          ) : (
            <>
              Showing <span className="font-medium text-foreground">{rangeStart.toLocaleString('en-IN')}</span>–
              <span className="font-medium text-foreground">{rangeEnd.toLocaleString('en-IN')}</span> of{' '}
              <span className="font-medium text-foreground">{total.toLocaleString('en-IN')}</span> {total === 1 ? noun : plural}
            </>
          )}
        </p>
        {onPageSizeChange && (
          <label className="flex items-center gap-1.5">
            <span>Per page</span>
            <SelectNative
              className="h-8 w-[4.5rem]"
              value={String(pageSize)}
              disabled={disabled}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </SelectNative>
          </label>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onPrev} disabled={disabled || !canPrev}>
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Prev
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={disabled || !canNext}>
          Next
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
