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
  GitCompareArrows,
  FileBarChart,
  LineChart,
  Download,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/app-shell/theme-toggle'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { signOut } from '@/lib/actions/auth'

const COLLAPSE_STORAGE_KEY = 'nav-rail-collapsed'

// Persistent left rail (MASTER-PLAN §5 "Navigation"). Export and Admin are
// admin-only per §4.4c's role table, and are now hidden outright
// from anyone who isn't an active admin — each of those pages already blocks
// non-admins server-side, so showing the link only ever produced a click that
// led to a refusal. That mattered little while every account was an admin; it
// matters now that departments have their own scoped accounts, for whom those
// two links are pure noise. (/import has no rail entry at all — it is reached
// from the dashboard's imports tile, which is gated the same way.)
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
  { label: 'Reconciliation', href: '/reconciliation', icon: GitCompareArrows },
  { label: 'Reports', href: '/reports', icon: FileBarChart },
  { label: 'Analytics', href: '/analytics', icon: LineChart },
  { label: 'Export', href: '/export', icon: Download, adminOnly: true },
  { label: 'Admin', href: '/admin', icon: Settings, adminOnly: true },
] as const

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

export function NavRail({
  user,
}: {
  user: { displayName: string; role: string | null; itsNumber: string | null }
}) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)

  const isAdmin = user.role === 'admin'
  const navItems = NAV_ITEMS.filter((item) => isAdmin || !('adminOnly' in item && item.adminOnly))

  // Per-visit override: true once the user manually re-expands the rail
  // while on /review. Not persisted — a ref (not state) so it survives
  // re-renders without triggering them, and it's reset to false the moment
  // pathname leaves /review so the next visit auto-collapses again.
  const reviewOverrideRef = useRef(false)

  // Auto-collapse on /review, restore the persisted preference elsewhere.
  // Runs on mount too (pathname is already known then), so a fresh load of
  // /review starts collapsed without waiting for a manual toggle.
  useEffect(() => {
    const onReview = pathname.startsWith('/review')
    if (onReview) {
      if (!reviewOverrideRef.current) {
        setCollapsed(true)
      }
    } else {
      reviewOverrideRef.current = false
      const stored = window.localStorage.getItem(COLLAPSE_STORAGE_KEY)
      setCollapsed(stored === 'true')
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
      setCollapsed(next)
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next))
    }
  }

  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
  const toggleButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={toggleCollapsed}
          aria-label={toggleLabel}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
          ) : (
            <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{toggleLabel}</TooltipContent>
    </Tooltip>
  )

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
            'flex items-center border-b border-border',
            collapsed ? 'flex-col gap-2 px-2 py-3' : 'justify-between gap-2 px-4 py-4'
          )}
        >
          <Logo imageClassName={collapsed ? 'w-8' : 'w-20'} />
          {toggleButton}
        </div>
        <ul className="flex-1 space-y-0.5 p-2">
          {navItems.map((item) => {
            const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
            const isAdminOnly = 'adminOnly' in item && item.adminOnly
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
                {!collapsed && isAdminOnly && (
                  <span className="ml-auto rounded border border-border px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                    Admin
                  </span>
                )}
              </Link>
            )
            return (
              <li key={item.href}>
                {collapsed ? (
                  <Tooltip>
                    <TooltipTrigger asChild>{link}</TooltipTrigger>
                    <TooltipContent side="right">
                      {item.label}
                      {isAdminOnly ? ' (Admin)' : ''}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  link
                )}
              </li>
            )
          })}
        </ul>
        <div className={cn('border-t border-border', collapsed ? 'p-2' : 'p-3')}>
          <div className={cn('flex items-center', collapsed ? 'flex-col gap-2' : 'gap-2.5')}>
            {collapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-xs font-semibold text-secondary-foreground"
                    tabIndex={0}
                  >
                    {initialsFor(user.displayName)}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {user.displayName}
                  {user.role ? ` — ${user.role}` : ''}
                </TooltipContent>
              </Tooltip>
            ) : (
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-xs font-semibold text-secondary-foreground"
                aria-hidden="true"
              >
                {initialsFor(user.displayName)}
              </div>
            )}
            <div className={cn('min-w-0 flex-1', collapsed && 'sr-only')}>
              <p className="truncate text-sm font-medium leading-tight text-foreground">{user.displayName}</p>
              {user.role && (
                <p className="truncate text-[11px] font-medium uppercase leading-tight tracking-wide text-muted-foreground">
                  {user.role}
                </p>
              )}
            </div>
            {collapsed ? (
              <form action={signOut}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="submit"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      aria-label="Sign out"
                    >
                      <LogOut className="h-4 w-4" strokeWidth={1.75} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Sign out</TooltipContent>
                </Tooltip>
              </form>
            ) : (
              <form action={signOut}>
                <Button
                  type="submit"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  aria-label="Sign out"
                >
                  <LogOut className="h-4 w-4" strokeWidth={1.75} />
                </Button>
              </form>
            )}
          </div>
          <div
            className={cn(
              'mt-2.5 flex items-center text-xs text-muted-foreground',
              collapsed ? 'flex-col gap-2' : 'justify-between gap-1.5'
            )}
          >
            {collapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <kbd
                    className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                    tabIndex={0}
                  >
                    Ctrl K
                  </kbd>
                </TooltipTrigger>
                <TooltipContent side="right">Ctrl K — jump to entry</TooltipContent>
              </Tooltip>
            ) : (
              <div className="flex items-center gap-1.5">
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                  Ctrl K
                </kbd>
                <span>jump to entry</span>
              </div>
            )}
            <ThemeToggle />
          </div>
        </div>
      </nav>
    </TooltipProvider>
  )
}
