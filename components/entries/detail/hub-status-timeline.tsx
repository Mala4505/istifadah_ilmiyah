import { Badge } from '@/components/ui/badge'
import { formatDateTime } from './format'
import type { ChangeLogRow, HubStatusOption } from './types'

/**
 * The Hub-status-only timeline (§3.9: "the entry detail screen surfaces the
 * status history as its own timeline, separate from the general
 * field-change list"). There is no separate table for it — this is
 * `entry_change_log` filtered (by the caller) to rows whose `changes`
 * contains a `hub_status_id` key. Newest first.
 */
export function HubStatusTimeline({
  rows,
  hubStatusById,
  resolveChangedBy,
}: {
  rows: ChangeLogRow[]
  hubStatusById: Map<number, HubStatusOption>
  resolveChangedBy: (userId: string | null) => string
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No Hub-status changes recorded yet for this entry.
      </p>
    )
  }

  return (
    <ol className="flex flex-col gap-3">
      {rows.map((row) => {
        const statusChange = row.changes.hub_status_id
        const fromId = typeof statusChange?.from === 'number' ? statusChange.from : null
        const toId = typeof statusChange?.to === 'number' ? statusChange.to : null
        const fromLabel = fromId !== null ? hubStatusById.get(fromId)?.label ?? `#${fromId}` : '—'
        const toLabel = toId !== null ? hubStatusById.get(toId)?.label ?? `#${toId}` : '—'
        const note = row.changes.hub_status_note?.to
        const noteText = typeof note === 'string' && note.trim() ? note : null

        return (
          <li key={row.id} className="rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{fromLabel}</Badge>
              <span className="text-muted-foreground">→</span>
              <Badge>{toLabel}</Badge>
            </div>
            <div className="mt-1.5 text-xs text-muted-foreground">
              {resolveChangedBy(row.changed_by)} · {formatDateTime(row.changed_at)}
            </div>
            {noteText && <p className="mt-1.5 text-sm">{noteText}</p>}
          </li>
        )
      })}
    </ol>
  )
}
