import { staffInitials } from '@/lib/assignment/queries'
import type { AssignmentWorkload, StaffWorkload } from '@/lib/assignment/workload'

/**
 * Superadmin workload board (document assignment, design §06 "Direction C").
 * Read-only, so this is a plain Server Component -- it just lays out the
 * numbers `getAssignmentWorkload` produced. Reassignment itself happens from
 * the inbox (Direction B), not here.
 *
 * Redesigned 2026-09-14: the original board packed four different numbers
 * (in progress / verified today / oldest unactioned / a load-comparison bar)
 * onto each card and testers couldn't tell what any of them meant. Replaced
 * with one segmented status bar (not started / in progress / verified) plus
 * a single "last reviewed" recency line.
 */

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

/** Coarse "how long ago" for the last-reviewed line -- doesn't need day-level precision. */
function timeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return '—'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
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

const STATUS_ROWS = [
  { key: 'notStartedCount', label: 'not started', dot: 'bg-border' },
  { key: 'inProgressCount', label: 'in progress', dot: 'bg-primary' },
  { key: 'verifiedCount', label: 'verified', dot: 'bg-emerald-600' },
] as const

/** One segmented bar: not-started (muted) / in-progress (primary) / verified (green),
 *  with a one-status-per-line breakdown underneath so labels never wrap or crowd. */
function StatusBar({ s }: { s: StaffWorkload }) {
  const total = Math.max(1, s.assignedCount)
  const pct = (n: number) => `${(n / total) * 100}%`

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        {s.notStartedCount > 0 && (
          <div className="h-full bg-border" style={{ width: pct(s.notStartedCount) }} />
        )}
        {s.inProgressCount > 0 && (
          <div className="h-full bg-primary" style={{ width: pct(s.inProgressCount) }} />
        )}
        {s.verifiedCount > 0 && (
          <div className="h-full bg-emerald-600" style={{ width: pct(s.verifiedCount) }} />
        )}
      </div>
      <div className="flex flex-col gap-1">
        {STATUS_ROWS.map(({ key, label, dot }) => (
          <div key={key} className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
              {label}
            </span>
            <span className="font-mono tabular-nums">{s[key]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function WorkloadBoard({ pool, perStaff }: AssignmentWorkload) {
  const assignedStaff = perStaff.filter((s) => s.assignedCount > 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
        {/* Pool column */}
        <div className="overflow-hidden rounded-lg border border-secondary bg-card">
          <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-3 py-2.5">
            <span className="rounded-full border border-dashed border-border px-2 py-0.5 font-mono text-[0.7rem] text-muted-foreground">
              Pool
            </span>
            <span className="ml-auto font-mono text-sm font-medium tabular-nums">{pool.count}</span>
          </div>
          <div className="flex flex-col gap-2 px-3 py-3">
            <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
              <span>oldest</span>
              <span className="tabular-nums">{ageLabel(pool.oldestDays)}</span>
            </div>
            <p className="text-xs text-muted-foreground">Unassigned — reassign from the inbox.</p>
          </div>
        </div>

        {assignedStaff.length === 0 ? (
          <div className="col-span-full rounded-lg border border-border bg-card px-3 py-6 text-sm text-muted-foreground">
            No documents assigned yet.
          </div>
        ) : (
          assignedStaff.map((s) => (
            <div key={s.staffId} className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-3 py-2.5">
                <Avatar name={s.displayName} id={s.staffId} />
                <span className="truncate text-sm">{s.displayName}</span>
                <span className="ml-auto font-mono text-sm font-medium tabular-nums">{s.assignedCount}</span>
              </div>
              <div className="flex flex-col gap-2.5 px-3 py-3">
                <StatusBar s={s} />
                <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
                  <span>last reviewed</span>
                  <span className="tabular-nums">{timeAgo(s.lastReviewedAt)}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
