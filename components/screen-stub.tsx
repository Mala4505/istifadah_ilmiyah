import { Card, CardContent } from '@/components/ui/card'

/**
 * Shared placeholder for every §5 screen that has no real data logic yet —
 * that depends on the SQL migrations and lib/ modules other agents are
 * writing concurrently. Renders the screen's title, its one-line purpose
 * from the §5 table, and a phase/day badge so it is obvious what ships
 * later. Swapped out screen-by-screen as each day's real implementation
 * lands.
 */
export function ScreenStub({
  title,
  purpose,
  badge,
  notes,
}: {
  title: string
  purpose: string
  badge: string
  notes?: string
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent-foreground">
          {badge}
        </span>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-2 pt-6">
          <p className="text-sm text-muted-foreground">{purpose}</p>
          {notes && <p className="text-xs text-muted-foreground">{notes}</p>}
        </CardContent>
      </Card>
    </div>
  )
}
