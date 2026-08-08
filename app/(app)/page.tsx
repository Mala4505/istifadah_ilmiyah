import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

// Screen 2 — Dashboard (MASTER-PLAN §5), moved here from the root
// placeholder now that /login and the authenticated shell exist. Every
// tile below will link to its filtered list once the reporting views
// (§10.2, built day 6) and entries list (day 3) exist; today it is a
// deliberate no-data shell, not a wired-up dashboard.
const TILES = [
  { label: 'Review queue depth', hint: 'Unverified extractions waiting' },
  { label: 'Open exceptions — ₹ at risk', hint: 'Sorted by severity' },
  { label: 'Budget burn', hint: 'Latest allocation vs. spend' },
  { label: "Today's imports", hint: 'Rows committed since midnight' },
] as const

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent-foreground">
          Phase 1A · Day 6
        </span>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Review queue depth, open exceptions by ₹ at risk, budget burn, and today&apos;s imports.
        Every tile links to its filtered list once the reporting views land.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {TILES.map((tile) => (
          <Card key={tile.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {tile.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-mono text-2xl font-semibold tracking-tight text-foreground">—</p>
              <p className="mt-1 text-xs text-muted-foreground">{tile.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
