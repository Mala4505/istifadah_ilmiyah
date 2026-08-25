'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Logo } from '@/components/app-shell/logo'
import {
  LayoutDashboard,
  ListChecks,
  FileStack,
  ScanLine,
  TriangleAlert,
  FileBarChart,
  Download,
  Settings,
  Keyboard,
  LogOut,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/app-shell/theme-toggle'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { signOut } from '@/lib/actions/auth'
import { isAdminOrAbove, isSuperadmin } from '@/lib/auth/roles'

/**
 * Collapse preference cookie (Task 7.8). Read server-side in
 * app/(app)/layout.tsx (mirrors how `active_event_id` is read, e.g.
 * lib/events/current.ts's getSelectedEventId) and passed down as
 * `initialCollapsed` so the very first client render already matches the
 * saved preference -- no expanded-then-collapsed flash while a
 * post-mount effect used to read localStorage. Written directly via
 * `document.cookie` on toggle (not a server action): this is a
 * per-browser UI preference, not data, so there is nothing to gate or
 * revalidate a route tree over.
 */
export const NAV_RAIL_COLLAPSED_COOKIE = 'nav_rail_collapsed'
const COLLAPSE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

// Persistent left rail (MASTER-PLAN §5 "Navigation"). Settings and Export
// are admin-only per §4.4c's role table, and each is hidden outright from
// anyone below that role — the page itself already blocks lower roles
// server-side, so showing the link only ever produced a click that led to a
// refusal. (/import has no rail entry at all — it is reached from the
// dashboard's imports tile, which is gated the same way.)
//
// This is presentation only. RLS in the database, and each page's own
// server-side gate, remain the real access boundary — a hidden link is not a
// permission check, and nothing here is relied on as one.
const NAV_ITEMS = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard },
  { label: 'Entries', href: '/entries', icon: ListChecks },
  { label: 'Documents', href: '/documents', icon: FileStack },
  { label: 'Review', href: '/review', icon: ScanLine },
  { label: 'Exceptions', href: '/exceptions', icon: TriangleAlert },
  { label: 'Reports', href: '/reports', icon: FileBarChart },
  { label: 'Shortcuts', href: '/shortcuts', icon: Keyboard },
  { label: 'Export', href: '/export', icon: Download, adminOnly: true },
  { label: 'Settings', href: '/settings', icon: Settings, adminOnly: true },
] as const

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

export function NavRail({
  user,
  initialCollapsed,
}: {
  user: { displayName: string; role: string | null; itsNumber: string | null }
  initialCollapsed: boolean
}) {
  const pathname = usePathname()
  // /review forces collapsed even on the very first render (matches the
  // effect below), so a fresh load of /review doesn't briefly show expanded
  // before the effect runs.
  const [collapsed, setCollapsed] = useState(() =>
    pathname.startsWith('/review') ? true : initialCollapsed
  )

  const isAdmin = isAdminOrAbove(user.role)
  const isSuperadminUser = isSuperadmin(user.role)
  const navItems = NAV_ITEMS.filter((item) => {
    if ('superadminOnly' in item && item.superadminOnly) return isSuperadminUser
    if ('adminOnly' in item && item.adminOnly) return isAdmin
    return true
  })

  // Per-visit override: true once the user manually re-expands the rail
  // while on /review. Not persisted — a ref (not state) so it survives
  // re-renders without triggering them, and it's reset to false the moment
  // pathname leaves /review so the next visit auto-collapses again.
  const reviewOverrideRef = useRef(false)

  // The last real (non-/review-forced) preference, used to restore the
  // rail when navigating away from /review during the same client-side
  // session (the layout stays mounted across soft navigations, so
  // `initialCollapsed` alone would go stale after a manual toggle).
  const lastPreferenceRef = useRef(initialCollapsed)

  // Auto-collapse on /review, restore the last real preference elsewhere.
  useEffect(() => {
    const onReview = pathname.startsWith('/review')
    if (onReview) {
      if (!reviewOverrideRef.current) {
        setCollapsed(true)
      }
    } else {
      reviewOverrideRef.current = false
      setCollapsed(lastPreferenceRef.current)
    }
  }, [pathname])

  function toggleCollapsed() {
    const next = !collapsed
    const onReview = pathname.startsWith('/review')
    if (onReview) {
      // Deliberate manual action on /review — track it as this visit's
      // override instead of persisting, since /review's default is forced
      // collapse rather than a real user preference. Expanding (next ===
      // false) sets the override; re-collapsing clears it.
      reviewOverrideRef.current = !next
      setCollapsed(next)
    } else {
      lastPreferenceRef.current = next
      setCollapsed(next)
      document.cookie = `${NAV_RAIL_COLLAPSED_COOKIE}=${next}; path=/; max-age=${COLLAPSE_COOKIE_MAX_AGE}`
    }
  }

  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar'

  return (
    <TooltipProvider delayDuration={200}>
      <nav
        className={cn(
          'sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200',
          collapsed ? 'w-14' : 'w-56'
        )}
      >
        <div
          className={cn(
            'flex items-center justify-center border-b border-border',
            collapsed ? 'px-2 py-6' : 'px-4 py-8'
          )}
        >
          <Logo imageClassName={collapsed ? 'w-9' : 'w-32'} />
        </div>

        {/* Collapse/expand handle: docked on the rail's right border, faint
            until the pointer is near the edge, brightening on hover/focus —
            keeps it out of the logo's way without hiding it outright. */}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={toggleLabel}
          className="group/edge absolute inset-y-0 -right-[18px] z-10 flex w-9 items-center justify-center"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card text-muted-foreground opacity-30 shadow-sm transition-opacity duration-150 group-hover/edge:opacity-100 group-focus-visible/edge:opacity-100">
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.9} />
            ) : (
              <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.9} />
            )}
          </span>
        </button>

        <ul className="flex-1 space-y-0.5 p-2">
          {navItems.map((item) => {
            const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
            const Icon = item.icon
            const link = (
              <Link
                href={item.href}
                className={cn(
                  'flex items-center rounded-md py-2 text-sm transition-colors',
                  collapsed ? 'justify-center px-0' : 'gap-2.5 px-3',
                  isActive
                    ? 'bg-accent font-medium text-accent-foreground shadow-[inset_2px_0_0_hsl(var(--primary))]'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                <span className={cn('truncate', collapsed && 'sr-only')}>{item.label}</span>
              </Link>
            )
            return (
              <li key={item.href}>
                {collapsed ? (
                  <Tooltip>
                    <TooltipTrigger asChild>{link}</TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                ) : (
                  link
                )}
              </li>
            )
          })}
        </ul>

        {/* Account footer: one row (avatar, and name/role when expanded)
            that opens a popover for everything else — shortcut hint, theme
            toggle, sign-out — instead of stacking them underneath. */}
        <div className={cn('border-t border-border', collapsed ? 'p-2' : 'p-3')}>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`${user.displayName}${user.role ? ` — ${user.role}` : ''}, account menu`}
                className={cn(
                  'flex w-full items-center rounded-md transition-colors hover:bg-secondary/60',
                  collapsed ? 'justify-center p-1.5' : 'gap-2.5 p-1.5'
                )}
              >
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-xs font-semibold text-secondary-foreground"
                  aria-hidden="true"
                >
                  {initialsFor(user.displayName)}
                </div>
                {!collapsed && (
                  <>
                    <div className="min-w-0 flex-1 text-left">
                      <p className="truncate text-sm font-medium leading-tight text-foreground">
                        {user.displayName}
                      </p>
                      {user.role && (
                        <p className="truncate text-[11px] font-medium uppercase leading-tight tracking-wide text-muted-foreground">
                          {user.role}
                        </p>
                      )}
                    </div>
                    <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  </>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align={collapsed ? 'center' : 'start'} sideOffset={8} className="w-56 p-2">
              <div className="px-1.5 py-1">
                <p className="truncate text-sm font-medium text-foreground">{user.displayName}</p>
                {user.role && (
                  <p className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {user.role}
                  </p>
                )}
              </div>
              <div className="my-1.5 border-t border-border" />
              <div className="flex items-center justify-between gap-2 px-1.5 py-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                    Alt K
                  </kbd>
                  <span>jump to entry</span>
                </div>
                <ThemeToggle />
              </div>
              <div className="my-1.5 border-t border-border" />
              <form action={signOut}>
                <Button
                  type="submit"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2 px-1.5 text-muted-foreground hover:text-destructive"
                >
                  <LogOut className="h-4 w-4" strokeWidth={1.75} />
                  Sign out
                </Button>
              </form>
            </PopoverContent>
          </Popover>
        </div>
      </nav>
    </TooltipProvider>
  )
}
