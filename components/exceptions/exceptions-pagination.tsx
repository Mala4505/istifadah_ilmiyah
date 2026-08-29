'use client'

import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { PaginationBar } from '@/components/ui/pagination-bar'

/**
 * URL-synced pagination for the Exceptions queue tab
 * (docs/hub-screen-certification.md §3.1). `page` and `size` live in the URL
 * so a position is shareable and survives a refresh. The server component
 * does the slicing and hands down the resolved range + total.
 */
export function ExceptionsPagination({
  page,
  size,
  rangeStart,
  rangeEnd,
  total,
}: {
  page: number
  size: number
  rangeStart: number
  rangeEnd: number
  total: number
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function go(next: URLSearchParams) {
    const query = next.toString()
    router.push(query ? `${pathname}?${query}` : pathname)
  }

  function setPage(nextPage: number) {
    const params = new URLSearchParams(searchParams.toString())
    if (nextPage <= 1) params.delete('page')
    else params.set('page', String(nextPage))
    go(params)
  }

  function setSize(nextSize: number) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('size', String(nextSize))
    // A resize changes which rows are on "page 1" — reset to the top.
    params.delete('page')
    go(params)
  }

  return (
    <PaginationBar
      noun="exception"
      rangeStart={rangeStart}
      rangeEnd={rangeEnd}
      total={total}
      pageSize={size}
      onPageSizeChange={setSize}
      canPrev={page > 1}
      canNext={rangeEnd < total}
      onPrev={() => setPage(page - 1)}
      onNext={() => setPage(page + 1)}
    />
  )
}
