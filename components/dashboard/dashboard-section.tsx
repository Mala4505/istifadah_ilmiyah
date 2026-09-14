import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Named group wrapper for the Dashboard (dashboard KPI regrouping). Every
 * section on the page answers one plain question ("what needs me right
 * now", "how's the budget", "where do entries stand") — this renders that
 * question as a heading so the page reads as a system of groups instead of
 * one flat row of unrelated tiles.
 */
export function DashboardSection({
  icon: Icon,
  title,
  description,
  aside,
  children,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
            {Icon && <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />}
            {title}
          </h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}
