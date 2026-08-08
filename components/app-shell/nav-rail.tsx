'use client'

import Link from 'next/link'
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
} from 'lucide-react'
import { cn } from '@/lib/utils'

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

export function NavRail() {
  const pathname = usePathname()

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
      <div className="border-b border-border px-4 py-4">
        <p className="text-sm font-semibold leading-tight tracking-tight">Istifada Ilmiyah</p>
        <p className="text-xs text-muted-foreground">Financial Hub</p>
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto p-2">
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
                    ? 'bg-secondary font-medium text-secondary-foreground'
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
      <div className="flex items-center gap-1.5 border-t border-border p-3 text-xs text-muted-foreground">
        <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
          Ctrl K
        </kbd>
        <span>jump to entry</span>
      </div>
    </nav>
  )
}
