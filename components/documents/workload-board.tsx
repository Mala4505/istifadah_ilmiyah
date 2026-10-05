import { staffInitials } from '@/lib/assignment/queries'
import type { AssignmentWorkload, StaffWorkload } from '@/lib/assignment/workload'
import { InteractiveTable, type InteractiveColumn, type InteractiveRow } from '@/components/ui/interactive-table'

/**
 * Superadmin workload board (document assignment, design §06 "Direction C").
 * Read-only Server Component laying out the numbers `getAssignmentWorkload`
 * produced. Reassignment itself happens from the inbox, not here.
 *
 * Redesigned 2026-10-05: one row per admin with BILL totals for the whole
 * selected event — assigned, pending, reviewing, reviewed, completed — plus
 * an event-wide totals strip, instead of per-admin cards that only showed
 * what was still sitting in the inbox.
 */

// Small deterministic avatar tint so rows are visually distinct. Fixed hex
// values (not theme tokens) because these are decorative identity colours.
const AVATAR_TONES = ['#8a5a2b', '#4f6d8c', '#6a7d3f', '#7a2438', '#5c6b8a', '#8a6d2b'] as const

function toneFor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return AVATAR_TONES[hash % AVATAR_TONES.length]!
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

const fmt = (n: number) => n.toLocaleString('en-IN')

const STAGES = [
  { key: 'pendingCount', label: 'Pending', hint: 'Not started yet', bar: 'bg-border' },
  { key: 'reviewingCount', label: 'Reviewing', hint: 'Open with the admin now', bar: 'bg-amber-500' },
  { key: 'reviewedCount', label: 'Reviewed', hint: 'Verified, not yet connected', bar: 'bg-primary' },
  { key: 'completedCount', label: 'Completed', hint: 'All review stages done', bar: 'bg-emerald-600' },
] as const

function StageBar({ s }: { s: Pick<StaffWorkload, (typeof STAGES)[number]['key'] | 'assignedCount'> }) {
  const total = Math.max(1, s.assignedCount)
  return (
    <div className="flex h-2 w-28 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      {STAGES.map(({ key, bar }) =>
        s[key] > 0 ? <div key={key} className={`h-full ${bar}`} style={{ width: `${(s[key] / total) * 100}%` }} /> : null
      )}
    </div>
  )
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

const COLUMNS: InteractiveColumn[] = [
  { key: 'admin', header: 'Admin', filterable: false },
  { key: 'assigned', header: 'Assigned', align: 'right', descendingFirst: true },
  { key: 'pending', header: 'Pending', align: 'right', descendingFirst: true },
  { key: 'reviewing', header: 'Reviewing', align: 'right', descendingFirst: true },
  { key: 'reviewed', header: 'Reviewed', align: 'right', descendingFirst: true },
  { key: 'completed', header: 'Completed', align: 'right', descendingFirst: true },
  { key: 'progress', header: 'Done', align: 'right', descendingFirst: true },
  { key: 'last', header: 'Last reviewed', descendingFirst: true, filterable: false },
]

export function WorkloadBoard({ pool, perStaff }: AssignmentWorkload) {
  const assignedStaff = perStaff.filter((s) => s.assignedCount > 0)

  const totals = assignedStaff.reduce(
    (acc, s) => ({
      assignedCount: acc.assignedCount + s.assignedCount,
      pendingCount: acc.pendingCount + s.pendingCount,
      reviewingCount: acc.reviewingCount + s.reviewingCount,
      reviewedCount: acc.reviewedCount + s.reviewedCount,
      completedCount: acc.completedCount + s.completedCount,
    }),
    { assignedCount: 0, pendingCount: 0, reviewingCount: 0, reviewedCount: 0, completedCount: 0 }
  )

  const rows: InteractiveRow[] = assignedStaff.map((s) => {
    const donePct = s.assignedCount > 0 ? Math.round((s.completedCount / s.assignedCount) * 100) : 0
    return {
      key: s.staffId,
      cells: [
        <span key="a" className="inline-flex items-center gap-2">
          <Avatar name={s.displayName} id={s.staffId} />
          <span>{s.displayName}</span>
        </span>,
        fmt(s.assignedCount),
        fmt(s.pendingCount),
        fmt(s.reviewingCount),
        fmt(s.reviewedCount),
        fmt(s.completedCount),
        <span key="p" className="inline-flex items-center justify-end gap-2">
          <StageBar s={s} />
          <span className="w-9 tabular-nums">{donePct}%</span>
        </span>,
        formatDate(s.lastReviewedAt),
      ],
      texts: [s.displayName, '', '', '', '', '', `${donePct}%`, formatDate(s.lastReviewedAt)],
      values: [
        s.displayName,
        s.assignedCount,
        s.pendingCount,
        s.reviewingCount,
        s.reviewedCount,
        s.completedCount,
        donePct,
        s.lastReviewedAt ? new Date(s.lastReviewedAt).getTime() : null,
      ],
    }
  })

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Bill totals for the selected event. Every bill on a document assigned to an admin counts once — a PDF with
        several bills counts several times.
      </p>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
        <div className="rounded-lg border border-border bg-card px-3 py-2.5">
          <p className="text-xs text-muted-foreground">Assigned</p>
          <p className="font-mono text-lg font-semibold tabular-nums">{fmt(totals.assignedCount)}</p>
          <p className="text-[11px] text-muted-foreground">bills, all admins</p>
        </div>
        {STAGES.map(({ key, label, hint, bar }) => (
          <div key={key} className="rounded-lg border border-border bg-card px-3 py-2.5">
            <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={`h-2 w-2 rounded-full ${bar}`} aria-hidden="true" />
              {label}
            </p>
            <p className="font-mono text-lg font-semibold tabular-nums">{fmt(totals[key])}</p>
            <p className="text-[11px] text-muted-foreground">{hint}</p>
          </div>
        ))}
        <div className="rounded-lg border border-dashed border-border bg-card px-3 py-2.5">
          <p className="text-xs text-muted-foreground">Unassigned pool</p>
          <p className="font-mono text-lg font-semibold tabular-nums">{fmt(pool.count)}</p>
          <p className="text-[11px] text-muted-foreground">
            {pool.oldestDays === null ? 'empty' : `oldest ${pool.oldestDays === 0 ? 'today' : `${pool.oldestDays}d`}`}
          </p>
        </div>
      </div>

      {assignedStaff.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-3 py-6 text-sm text-muted-foreground">
          No documents assigned for this event yet.
        </div>
      ) : (
        <InteractiveTable
          columns={COLUMNS}
          rows={rows}
          initialSort={{ index: 1, direction: 'desc' }}
          searchPlaceholder="Search admins…"
          noun="admin"
          footer={
            <tr>
              <td className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">Total</td>
              {(['assignedCount', 'pendingCount', 'reviewingCount', 'reviewedCount', 'completedCount'] as const).map((k) => (
                <td key={k} className="px-3 py-2 text-right font-mono tabular-nums">
                  {fmt(totals[k])}
                </td>
              ))}
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {totals.assignedCount > 0 ? Math.round((totals.completedCount / totals.assignedCount) * 100) : 0}%
              </td>
              <td />
            </tr>
          }
        />
      )}
    </div>
  )
}
