import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { formatNumber } from '@/lib/reports/format'
import { statusBadgeVariant } from '@/lib/status-badge'

/**
 * One row of a status-count breakdown (Hub Refinements plan §0 item 3): a
 * single value of one of the three status dimensions (docs/hub-refinements-plan.md
 * §2 — Status, Audit status, Hub status are independent fields, not one),
 * with the entry count sitting at that value. `id` is null for the
 * synthetic "not set" row `v_entry_status_counts` emits when status_id /
 * audit_status_id is null on the entry (see that view's header comment) —
 * there's no real id to filter `/entries` on in that case, so callers must
 * not link it.
 */
export type StatusCount = {
  id: number | null
  code: string
  label: string
  count: number
}

/**
 * Kept as a named re-export so app/(app)/page.tsx's import site is untouched.
 * The implementation now lives in lib/status-badge.ts and is shared with the
 * Entries table (docs/hub-screen-certification.md §3.3 — one status colour
 * map, so "Pending" is no longer grey on Entries and amber here).
 */
export function dashboardStatusBadgeVariant(code: string, label: string): BadgeProps['variant'] {
  return statusBadgeVariant(code, label)
}

/**
 * Compact per-dimension status-count card for the Dashboard (distinct from
 * and in addition to the five stat tiles above it). Every badge with a real
 * `id` links to `/entries` pre-filtered to that status value, using the
 * exact URL param name `entries-explorer.tsx`'s `filtersToSearchParams`
 * syncs to (`st` / `ast` / `hs`) — see that file for the full param map.
 *
 * `emphasizeCodes` pulls specific rows (by status code) out of the badge
 * list and renders them as larger mini-tiles above it — used for Hub status,
 * the only field this app ever writes and the only thing ever exported back
 * out, so "how many Awaiting Verification vs Awaiting Validation" needs to
 * read at a glance rather than being just another badge in the row.
 */
export function StatusCountCard({
  title,
  icon: Icon,
  rows,
  paramKey,
  variantFor,
  emphasizeCodes,
  emptyHint,
}: {
  title: string
  icon?: LucideIcon
  rows: StatusCount[]
  paramKey: 'st' | 'ast' | 'hs'
  variantFor: (code: string, label: string) => BadgeProps['variant']
  emphasizeCodes?: string[]
  emptyHint?: string
}) {
  const total = rows.reduce((sum, r) => sum + r.count, 0)
  const emphasized = emphasizeCodes ? rows.filter((r) => emphasizeCodes.includes(r.code)) : []
  const rest = emphasizeCodes ? rows.filter((r) => !emphasizeCodes.includes(r.code)) : rows

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyHint ?? 'No entries yet.'}</p>
        ) : (
          <>
            {emphasized.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {emphasized.map((row) => (
                  <StatusLink key={row.code} id={row.id} paramKey={paramKey} className="block">
                    <div className="rounded-md border border-border px-3 py-2 transition-colors hover:border-foreground/25 hover:bg-accent/40">
                      <p className="font-mono text-xl font-semibold tracking-tight text-foreground">
                        {formatNumber(row.count)}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{row.label}</p>
                    </div>
                  </StatusLink>
                ))}
              </div>
            )}

            {rest.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {rest.map((row) => (
                  <StatusLink key={row.code} id={row.id} paramKey={paramKey}>
                    <Badge variant={variantFor(row.code, row.label)} className="gap-1">
                      {row.label}
                      <span className="font-mono">{formatNumber(row.count)}</span>
                    </Badge>
                  </StatusLink>
                ))}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{formatNumber(total)}</span> total
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function StatusLink({
  id,
  paramKey,
  className,
  children,
}: {
  id: number | null
  paramKey: 'st' | 'ast' | 'hs'
  className?: string
  children: React.ReactNode
}) {
  // No real id (the synthetic "not set" row) means there's nothing to filter
  // /entries on -- render inert rather than link to an unfiltered list that
  // would silently include every other status too.
  if (id === null) {
    return <span className={cn('cursor-default opacity-80', className)}>{children}</span>
  }
  return (
    <Link
      href={`/entries?${paramKey}=${id}`}
      className={cn('rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background', className)}
    >
      {children}
    </Link>
  )
}
