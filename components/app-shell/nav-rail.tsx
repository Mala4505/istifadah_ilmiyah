'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  ListChecks,
  FileStack,
  ScanLine,
  TriangleAlert,
  GitCompareArrows,
  FileBarChart,
  Download,
  Settings,
  LogOut,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/app-shell/theme-toggle'
import { Button } from '@/components/ui/button'
import { signOut } from '@/lib/actions/auth'

// Persistent left rail (MASTER-PLAN §5 "Navigation"). Export and Admin are
// admin-only per §4.4c's role table. Role-based hiding is not wired up yet
// — `staff_profile.role` doesn't exist until the SQL migrations land — so
// every item renders for now. RLS in the database is the real access
// boundary regardless of what this nav shows.
const NAV_ITEMS = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard },
  { label: 'Entries', href: '/entries', icon: ListChecks },
  { label: 'Documents', href: '/documents', icon: FileStack },
  { label: 'Review', href: '/review', icon: ScanLine },
  { label: 'Exceptions', href: '/exceptions', icon: TriangleAlert },
  { label: 'Reconciliation', href: '/reconciliation', icon: GitCompareArrows },
  { label: 'Reports', href: '/reports', icon: FileBarChart },
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

  return (
    <nav className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center justify-center border-b border-border px-4 py-4">
        <Image
          src="/istifadah_logo_1_alpha.png"
          alt="Istifadah Ilmiyah"
          width={505}
          height={502}
          priority
          className="h-auto w-20"
        />
      </div>
      <ul className="flex-1 space-y-0.5 p-2">
        {NAV_ITEMS.map((item) => {
          const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
          const Icon = item.icon
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-accent font-medium text-accent-foreground shadow-[inset_2px_0_0_hsl(var(--primary))]'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                <span className="truncate">{item.label}</span>
                {'adminOnly' in item && item.adminOnly && (
                  <span className="ml-auto rounded border border-border px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                    Admin
                  </span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-xs font-semibold text-secondary-foreground"
            aria-hidden="true"
          >
            {initialsFor(user.displayName)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium leading-tight text-foreground">{user.displayName}</p>
            {user.role && (
              <p className="truncate text-[11px] font-medium uppercase leading-tight tracking-wide text-muted-foreground">
                {user.role}
              </p>
            )}
          </div>
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
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              Ctrl K
            </kbd>
            <span>jump to entry</span>
          </div>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  )
}
