'use client'

/**
 * The Reports workspace left rail (redesign plan Phase 3.1b). One column,
 * rendered from app/(app)/reports/layout.tsx beside the pane:
 *
 *   ★ My reports   — the viewer's pins (Phase 3.1d), floated to the top
 *   Overview       — the per-surface overview composition (?report unset)
 *   <sections>     — the current surface's section list (surface-sections.ts)
 *
 * Selecting a row swaps the pane via `?report=<id>` (Phase 3.3) — real
 * navigation, not local state, so each section keeps its own URL and the
 * back button works. A search box appears only on Explore, which carries
 * every section in one long list; the focused surfaces are short enough to
 * scan.
 *
 * Type-only import from lib/reports/pins is fine, but note this component
 * never imports that module's value exports (it pulls `next/headers` at
 * module scope) — pins arrive as a prop and changes go through the
 * `toggleReportPin` server action.
 */
import { useEffect, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { toastError } from '@/components/ui/error-toast'
import { toggleReportPin } from '@/lib/actions/reports'
import {
  OVERVIEW_SECTION,
  SURFACE_SECTIONS,
  homeSurfaceForSection,
  labelForSectionId,
  sectionHref,
  surfaceForPathname,
} from '@/lib/reports/surface-sections'

export function ReportIndex({ pins: initialPins }: { pins: string[] }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const activeReport = searchParams.get('report')
  const surface = surfaceForPathname(pathname)
  const [pins, setPins] = useState(initialPins)
  const [isPending, startTransition] = useTransition()
  const [query, setQuery] = useState('')

  // Keep local pin state in step with the cookie-derived prop after a
  // full navigation / reload.
  useEffect(() => setPins(initialPins), [initialPins])

  const filtered = useMemo(() => {
    const sections = surface ? SURFACE_SECTIONS[surface] : []
    if (surface !== 'explore' || !query.trim()) return sections
    const q = query.trim().toLowerCase()
    return sections.filter((s) => s.label.toLowerCase().includes(q))
  }, [surface, query])

  function togglePin(id: string) {
    startTransition(async () => {
      const result = await toggleReportPin(id)
      if (!result.ok) {
        toastError(result.error, { context: 'report-index-pin' })
        return
      }
      setPins(result.pins)
    })
  }

  const isSectionActive = (id: string) => activeReport === id
  // Overview = the surface's bare route with no ?report. On the Brief
  // (surface === null) the "Overview" row points at the Brief root itself.
  const overviewHref = surface ? sectionHref(surface, null) : '/reports/brief'
  const overviewActive = !activeReport && pathname === overviewHref

  return (
    <nav aria-label="Report sections" data-hide-in-present className="flex w-full flex-col gap-4 text-sm">
      {pins.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">★ My reports</p>
          {pins.map((id) => {
            const home = homeSurfaceForSection(id)
            const label = labelForSectionId(id)
            if (!home || !label) return null
            return (
              <IndexRow
                key={`pin-${id}`}
                href={sectionHref(home, id)}
                label={label}
                active={isSectionActive(id) && (!surface || home === surface)}
                pinned
                pinBusy={isPending}
                onTogglePin={() => togglePin(id)}
              />
            )
          })}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <Link
          href={overviewHref}
          aria-current={overviewActive ? 'page' : undefined}
          className={cn(
            'rounded-md px-2 py-1.5 font-medium transition-colors',
            overviewActive
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
          )}
        >
          {OVERVIEW_SECTION.label}
        </Link>

        {surface === 'explore' && (
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter reports…"
            aria-label="Filter reports"
            className="my-1 h-8"
          />
        )}

        {filtered.map((s) => (
          <IndexRow
            key={s.id}
            href={sectionHref(surface!, s.id)}
            label={s.label}
            active={isSectionActive(s.id)}
            pinned={pins.includes(s.id)}
            pinBusy={isPending}
            onTogglePin={() => togglePin(s.id)}
          />
        ))}

        {surface === 'explore' && query.trim() && filtered.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">No report matches “{query.trim()}”.</p>
        )}

        {surface === null && (
          <Link
            href="/reports"
            className="rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
          >
            Explore all reports →
          </Link>
        )}
      </div>
    </nav>
  )
}

function IndexRow({
  href,
  label,
  active,
  pinned,
  pinBusy,
  onTogglePin,
}: {
  href: string
  label: string
  active: boolean
  pinned: boolean
  pinBusy: boolean
  onTogglePin: () => void
}) {
  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-md pr-1 transition-colors',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-secondary/60',
      )}
    >
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'min-w-0 flex-1 truncate px-2 py-1.5 transition-colors',
          active ? 'text-accent-foreground' : 'text-muted-foreground group-hover:text-foreground',
        )}
      >
        {label}
      </Link>
      <button
        type="button"
        onClick={onTogglePin}
        disabled={pinBusy}
        aria-pressed={pinned}
        aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
        className={cn(
          'shrink-0 rounded p-1 text-muted-foreground transition-opacity hover:text-foreground disabled:opacity-50',
          pinned ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
        )}
      >
        <Star className={cn('h-3.5 w-3.5', pinned && 'fill-current text-amber-500')} />
      </button>
    </div>
  )
}
