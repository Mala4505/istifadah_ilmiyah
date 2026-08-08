import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * Dashboard tile (MASTER-PLAN §5 row 2). Every tile is a link to its
 * filtered list — the whole card is the click target, not a small "view
 * all" affordance buried in a corner.
 */
export function StatTile({
  label,
  value,
  hint,
  href,
  icon: Icon,
  tone = 'default',
  error,
}: {
  label: string
  value: string
  hint?: string
  href: string
  icon?: LucideIcon
  tone?: 'default' | 'warning' | 'critical'
  error?: string | null
}) {
  return (
    <Link
      href={href}
      className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card className="h-full transition-colors group-hover:border-foreground/25 group-hover:bg-accent/40">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />}
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="text-sm text-destructive">Couldn&apos;t load this tile</p>
          ) : (
            <>
              <p
                className={cn(
                  'font-mono text-2xl font-semibold tracking-tight',
                  tone === 'critical' && 'text-destructive',
                  tone === 'warning' && 'text-amber-600 dark:text-amber-400',
                  tone === 'default' && 'text-foreground'
                )}
              >
                {value}
              </p>
              {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
            </>
          )}
        </CardContent>
      </Card>
    </Link>
  )
}
