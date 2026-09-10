import Link from 'next/link'
import { cn } from '@/lib/utils'

/**
 * Superadmin-only `Inbox | Workload` switch for /documents (redesign plan
 * Phase 1.2). The workload board used to be its own nav item + route
 * (/documents/workload); it now folds in here as a view of the same screen,
 * selected by `?view=`. `/documents/workload` still exists as a redirect to
 * `?view=workload` for anything that linked to the old URL.
 *
 * A plain link row (pattern: components/app-shell/report-surface-nav.tsx) --
 * each view is a real navigation, not client tab state, and the server
 * component already knows the active view from its own searchParams so this
 * needs no 'use client'.
 */
const VIEWS = [
  { view: 'inbox', href: '/documents', label: 'Inbox' },
  { view: 'workload', href: '/documents?view=workload', label: 'Workload' },
] as const

export function InboxViewNav({ current }: { current: 'inbox' | 'workload' }) {
  return (
    <nav className="flex flex-wrap gap-1" aria-label="Document views" data-hide-in-present>
      {VIEWS.map((v) => {
        const isActive = v.view === current
        return (
          <Link
            key={v.view}
            href={v.href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
            )}
          >
            {v.label}
          </Link>
        )
      })}
    </nav>
  )
}
