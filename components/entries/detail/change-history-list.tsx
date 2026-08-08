import { Badge } from '@/components/ui/badge'
import { formatChangeValue, formatDateTime, humanizeFieldName } from './format'
import type { ChangeLogRow } from './types'

const SOURCE_LABEL: Record<string, string> = {
  import: 'Import',
  manual: 'Manual edit',
  system: 'System',
}

/**
 * The general change-history tab (§3.9, task point 4): every
 * `entry_change_log` row for this entry, newest first, all fields — not
 * just Hub status (that lives in its own timeline, see
 * hub-status-timeline.tsx).
 */
export function ChangeHistoryList({
  rows,
  resolveChangedBy,
  resolveLookup,
}: {
  rows: ChangeLogRow[]
  resolveChangedBy: (userId: string | null) => string
  resolveLookup: (field: string, id: number) => string | null
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No changes recorded yet for this entry.</p>
  }

  return (
    <ol className="flex flex-col gap-3">
      {rows.map((row) => {
        const fields = Object.entries(row.changes)
        return (
          <li key={row.id} className="rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {resolveChangedBy(row.changed_by)} · {formatDateTime(row.changed_at)}
              </span>
              <Badge variant="outline">{SOURCE_LABEL[row.source] ?? row.source}</Badge>
            </div>
            <ul className="mt-2 flex flex-col gap-1">
              {fields.map(([field, diff]) => (
                <li key={field} className="text-sm">
                  <span className="font-medium">{humanizeFieldName(field)}:</span>{' '}
                  <span className="text-muted-foreground">
                    {formatChangeValue(field, diff.from, resolveLookup)}
                  </span>{' '}
                  <span className="text-muted-foreground">→</span>{' '}
                  <span>{formatChangeValue(field, diff.to, resolveLookup)}</span>
                </li>
              ))}
            </ul>
          </li>
        )
      })}
    </ol>
  )
}
