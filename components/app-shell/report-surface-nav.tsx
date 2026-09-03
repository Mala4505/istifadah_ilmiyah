'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

/**
 * The five Reports front doors (reporting-blueprint.md §5 "Screen
 * architecture" / §8 Phase Three). Rendered from
 * app/(app)/reports/layout.tsx so it sits under the sticky period bar on
 * every Reports route. Separating the audiences is the whole point of the
 * split -- Executive Brief for trustees, Budget & Spend for department
 * heads, Vendors & Purchases for procurement, Integrity for the review
 * function, and Explore (the former single page) kept as the pivot/drill
 * workspace.
 *
 * A link row, not the Radix Tabs primitive: each surface is its own route
 * with its own `loading.tsx`, so navigation is real navigation, not local
 * tab state.
 */
const SURFACES = [
  { href: '/reports/brief', label: 'Executive Brief' },
  { href: '/reports/budget', label: 'Budget & Spend' },
  { href: '/reports/vendors', label: 'Vendors & Purchases' },
  { href: '/reports/integrity', label: 'Integrity' },
  { href: '/reports', label: 'Explore' },
] as const

export function ReportSurfaceNav() {
  const pathname = usePathname()

  return (
    <nav
      className="-mt-1 mb-2 flex flex-wrap gap-1 border-b border-border pb-2"
      aria-label="Report surfaces"
      // Present mode (§5) strips in-page navigation for the projector.
      data-hide-in-present
    >
      {SURFACES.map((surface) => {
        // `/reports` (Explore) is only active on an exact match -- otherwise
        // it would light up on every nested surface too.
        const isActive =
          surface.href === '/reports' ? pathname === '/reports' : pathname.startsWith(surface.href)
        return (
          <Link
            key={surface.href}
            href={surface.href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
            )}
          >
            {surface.label}
          </Link>
        )
      })}
    </nav>
  )
}
