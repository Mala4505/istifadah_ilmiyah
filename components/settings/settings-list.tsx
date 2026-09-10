import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SettingsRowHelp } from '@/components/settings/settings-row-help'

/**
 * The Settings row-list primitive (Phase 2 redesign, Direction A): one
 * plain fixed-order list of grouped rows edited in place. No tabs, no
 * status strip, no charts, no badges -- counts are plain sublabel text,
 * never alerts. A row either links to a focused sub-route (`href`, shows
 * a chevron) or carries an inline `control`; the longer description sits
 * behind a `?` popover so the list stays scannable.
 */
export type SettingsRow = {
  label: string
  /** Plain-text status line under the label, e.g. "12 active · 3 pending". */
  sublabel?: string
  /** Long "what is this" copy, shown only behind the row's `?` popover. */
  description?: string
  /** Inline control (switcher, stepper). Mutually exclusive with `href`. */
  control?: ReactNode
  /** Focused sub-route this row opens. Mutually exclusive with `control`. */
  href?: string
}

export type SettingsGroup = {
  heading: string
  rows: SettingsRow[]
}

function RowBody({ row }: { row: SettingsRow }) {
  return (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{row.label}</span>
          {row.description && <SettingsRowHelp label={row.label} description={row.description} />}
        </div>
        {row.sublabel && (
          <p className="mt-0.5 text-xs text-muted-foreground">{row.sublabel}</p>
        )}
      </div>
      {row.href ? (
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      ) : (
        row.control && <div className="shrink-0">{row.control}</div>
      )}
    </>
  )
}

export function SettingsList({ groups }: { groups: SettingsGroup[] }) {
  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.heading} className="flex flex-col gap-1">
          <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {group.heading}
          </h2>
          <div className="divide-y divide-border rounded-lg border border-border bg-card">
            {group.rows.map((row) => {
              const inner = <RowBody row={row} />
              return row.href ? (
                <Link
                  key={row.label}
                  href={row.href}
                  className={cn(
                    'flex items-center gap-3 px-4 py-3 transition-colors',
                    'hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  )}
                >
                  {inner}
                </Link>
              ) : (
                <div key={row.label} className="flex items-center gap-3 px-4 py-3">
                  {inner}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
