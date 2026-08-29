import { staffInitials } from '@/lib/assignment/queries'
import type { AssignmentWorkload } from '@/lib/assignment/workload'

/**
 * Superadmin workload board (document assignment, design §06 "Direction C").
 * Read-only, so this is a plain Server Component -- it just lays out the
 * numbers `getAssignmentWorkload` produced. Reassignment itself happens from
 * the inbox (Direction B), not here.
 *
 * "Oldest unactioned" is the real SLA signal: it turns a warning colour once
 * an admin's oldest outstanding document passes STALE_DAYS.
 */
const STALE_DAYS = 7

// Small deterministic avatar tint so columns are visually distinct without
// pulling in another component. Fixed hex values (not theme tokens) because
// these are decorative identity colours, same idea as the design mock.
const AVATAR_TONES = ['#8a5a2b', '#4f6d8c', '#6a7d3f', '#7a2438', '#5c6b8a', '#8a6d2b'] as const

function toneFor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return AVATAR_TONES[hash % AVATAR_TONES.length]!
}

function ageLabel(days: number | null): string {
  if (days === null) return '—'
  if (days === 0) return 'today'
  return `${days}d`
}

function Avatar({ name, id }: { name: string; id: string }) {
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-[0.6rem] font-medium text-white"
      style={{ backgroundColor: toneFor(id) }}
      aria-hidden="true"
    >
      {staffInitials(name)}
    </span>
  )
}

function StatLine({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between font-mono text-xs ${
        alert ? 'text-destructive' : 'text-muted-foreground'
      }`}
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

export function WorkloadBoard({ pool, perStaff }: AssignmentWorkload) {
  const maxAssigned = Math.max(1, ...perStaff.map((s) => s.assignedCount))

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
        {/* Pool column */}
        <div className="overflow-hidden rounded-lg border border-secondary bg-card">
          <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-3 py-2.5">
            <span className="rounded-full border border-dashed border-border px-2 py-0.5 font-mono text-[0.7rem] text-muted-foreground">
              Pool
            </span>
            <span className="ml-auto font-mono text-sm font-medium tabular-nums">{pool.count}</span>
          </div>
          <div className="flex flex-col gap-2 px-3 py-3">
            <StatLine
              label="oldest"
              value={ageLabel(pool.oldestDays)}
              alert={pool.oldestDays !== null && pool.oldestDays > STALE_DAYS}
            />
            <p className="text-xs text-muted-foreground">Unassigned — reassign from the inbox.</p>
          </div>
        </div>

        {perStaff.length === 0 ? (
          <div className="col-span-full rounded-lg border border-border bg-card px-3 py-6 text-sm text-muted-foreground">
            No active admins to show.
          </div>
        ) : (
          perStaff.map((s) => {
            const stale = s.oldestUnactionedDays !== null && s.oldestUnactionedDays > STALE_DAYS
            const barPct = Math.round((s.assignedCount / maxAssigned) * 100)
            return (
              <div key={s.staffId} className="overflow-hidden rounded-lg border border-border bg-card">
                <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-3 py-2.5">
                  <Avatar name={s.displayName} id={s.staffId} />
                  <span className="truncate text-sm">{s.displayName}</span>
                  <span className="ml-auto font-mono text-sm font-medium tabular-nums">{s.assignedCount}</span>
                </div>
                <div className="flex flex-col gap-1.5 px-3 py-3">
                  <StatLine label="in progress" value={String(s.inProgressCount)} />
                  <StatLine label="verified today" value={String(s.verifiedTodayCount)} />
                  <StatLine label="oldest unactioned" value={ageLabel(s.oldestUnactionedDays)} alert={stale} />
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full ${stale ? 'bg-destructive' : 'bg-primary'}`}
                      style={{ width: `${Math.max(barPct, s.assignedCount > 0 ? 6 : 0)}%` }}
                    />
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm bg-primary" aria-hidden="true" /> assigned load
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm bg-destructive" aria-hidden="true" /> stale — oldest &gt; {STALE_DAYS} days
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm border border-secondary bg-transparent" aria-hidden="true" /> unassigned pool
        </span>
      </div>
    </div>
  )
}
