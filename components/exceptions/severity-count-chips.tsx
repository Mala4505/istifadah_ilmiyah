'use client'

import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { severityBadgeVariant, SEVERITY_GROUP_LABELS, SEVERITY_VALUES } from '@/components/exceptions/labels'
import { badgeVariants } from '@/components/ui/badge'

/**
 * Compact High / Medium / Low count chips above the queue
 * (docs/hub-screen-certification.md §3.7). Counts are of *open* exceptions
 * regardless of the current filter; clicking a chip applies the §3.4
 * severity filter (clicking the active one clears it).
 */
export function SeverityCountChips({
  counts,
  activeSeverity,
}: {
  counts: Record<string, number>
  activeSeverity: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function applySeverity(severity: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (activeSeverity === severity) params.delete('severity')
    else params.set('severity', severity)
    params.delete('page')
    const query = params.toString()
    router.push(query ? `${pathname}?${query}` : pathname)
  }

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Open exceptions by severity">
      {SEVERITY_VALUES.map((severity) => {
        const isActive = activeSeverity === severity
        return (
          <button
            key={severity}
            type="button"
            aria-pressed={isActive}
            onClick={() => applySeverity(severity)}
            className={cn(
              badgeVariants({ variant: severityBadgeVariant(severity) }),
              'gap-1.5 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              !isActive && 'opacity-70'
            )}
          >
            <span>{(SEVERITY_GROUP_LABELS[severity] ?? severity).replace(' severity', '')}</span>
            <span className="tabular-nums font-semibold">{(counts[severity] ?? 0).toLocaleString('en-IN')}</span>
          </button>
        )
      })}
    </div>
  )
}
