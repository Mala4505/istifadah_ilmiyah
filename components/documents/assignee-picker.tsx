'use client'

import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import type { AssignableStaff } from '@/lib/assignment/queries'
import { StaffAvatar } from './assignee-chip'

/**
 * Reusable multi-select for document assignment ("dividing the document
 * inbox", 2026-08-29). Used in two places with the same shape:
 *   - the upload dropzone's staged-files confirmation area (assign on the way in)
 *   - the inbox bulk-action bar's "Assign to…" dialog (reassignment)
 *
 * Controlled: the parent owns the selected-id list. An empty list is the
 * explicit "leave unassigned / send to the pool" state — it maps straight to
 * the ingest route's absent `assignedTo` and to `setDocumentAssignees([])`.
 * The "Leave unassigned" row is a visible affordance for that state, not a
 * separate mode.
 */
export function AssigneePicker({
  staff,
  value,
  onChange,
  className,
}: {
  staff: AssignableStaff[]
  /** Selected staff uuids. `[]` = unassigned / shared pool. */
  value: string[]
  onChange: (ids: string[]) => void
  className?: string
}) {
  const selected = new Set(value)

  function toggle(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    // Preserve the staff order rather than Set insertion order.
    onChange(staff.filter((s) => next.has(s.id)).map((s) => s.id))
  }

  return (
    <div className={cn('flex flex-col', className)}>
      {staff.length === 0 ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">
          No active admins to assign to.
        </p>
      ) : (
        <ul className="flex flex-col">
          {staff.map((s) => {
            const isChecked = selected.has(s.id)
            return (
              <li key={s.id}>
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60',
                    isChecked && 'bg-muted/40'
                  )}
                >
                  <Checkbox checked={isChecked} onCheckedChange={() => toggle(s.id)} aria-label={`Assign to ${s.displayName}`} />
                  <StaffAvatar displayName={s.displayName} seed={s.id} />
                  <span className="min-w-0 flex-1 truncate">{s.displayName}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {s.openCount} open
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={() => onChange([])}
        className={cn(
          'mt-1 flex items-center gap-2.5 rounded-md border-t border-border px-2 py-2 text-left text-sm text-muted-foreground hover:bg-muted/60',
          value.length === 0 && 'font-medium text-foreground'
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
            value.length === 0 ? 'border-primary' : 'border-muted-foreground/40'
          )}
        >
          {value.length === 0 && <span className="h-2 w-2 rounded-full bg-primary" />}
        </span>
        Leave unassigned — decide in the inbox
      </button>
    </div>
  )
}

/** First names of the selected staff, for confirm-button copy ("assign to Fatima + Yusuf"). */
export function assigneeFirstNames(staff: AssignableStaff[], ids: string[]): string {
  const set = new Set(ids)
  return staff
    .filter((s) => set.has(s.id))
    .map((s) => s.displayName.trim().split(/\s+/)[0])
    .join(' + ')
}
