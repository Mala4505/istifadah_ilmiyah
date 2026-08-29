'use client'

/**
 * Scope switcher for the /documents inbox ("dividing the document inbox",
 * 2026-08-29). Mirrors components/review/queue-scope-toggle.tsx's shape — a
 * small segmented control in the page header — but it carries no server
 * action: scope is a plain URL param, so this just pushes `?scope=` /
 * `?assignee=` and lets the RSC re-read `searchParams` and re-filter.
 *
 *   admin       — All (default: their assigned + the unassigned pool) /
 *                 Mine / Unassigned
 *   superadmin  — Everyone (default) / Mine / Unassigned, plus an
 *                 "Assigned to <person>" picker for a single-person view
 */

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { SelectNative } from '@/components/ui/select-native'
import { cn } from '@/lib/utils'
import type { AssignableStaff } from '@/lib/assignment/queries'

export type DocumentScope = 'all' | 'mine' | 'unassigned' | 'everyone'

export function AssignmentScope({
  isSuperadmin,
  scope,
  assigneeId,
  staff,
  counts,
}: {
  isSuperadmin: boolean
  scope: DocumentScope
  /** A single-person filter (superadmin only); null when a plain scope is active. */
  assigneeId: string | null
  staff: AssignableStaff[]
  counts: { mine: number; unassigned: number; everyone: number }
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function go(query: string) {
    startTransition(() => {
      router.push(query ? `/documents?${query}` : '/documents')
    })
  }

  function selectScope(next: DocumentScope) {
    if (isPending) return
    if (next === scope && assigneeId === null) return
    // The admin default is `all`; the superadmin default is `everyone`. Drop
    // the param entirely when it matches the default so the URL stays clean.
    const isDefault = isSuperadmin ? next === 'everyone' : next === 'all'
    go(isDefault ? '' : `scope=${next}`)
  }

  function selectAssignee(id: string) {
    if (isPending) return
    go(id ? `assignee=${id}` : '')
  }

  const options: Array<[DocumentScope, string, number | null]> = isSuperadmin
    ? [
        ['everyone', 'Everyone', counts.everyone],
        ['mine', 'Mine', counts.mine],
        ['unassigned', 'Unassigned', counts.unassigned],
      ]
    : [
        ['all', 'All', counts.everyone],
        ['mine', 'Mine', counts.mine],
        ['unassigned', 'Unassigned', counts.unassigned],
      ]

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex items-center rounded-md border border-border p-0.5 text-xs">
        {options.map(([value, label, count]) => {
          const active = assigneeId === null && scope === value
          return (
            <button
              key={value}
              type="button"
              onClick={() => selectScope(value)}
              disabled={isPending}
              aria-pressed={active}
              className={cn(
                'rounded px-2 py-1 font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted disabled:opacity-60'
              )}
            >
              {label}
              {count !== null && <span className="ml-1 tabular-nums opacity-80">· {count}</span>}
            </button>
          )
        })}
      </div>

      {isSuperadmin && staff.length > 0 && (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Assigned to</span>
          <SelectNative
            value={assigneeId ?? ''}
            onChange={(e) => selectAssignee(e.target.value)}
            disabled={isPending}
            className="h-8 w-44 text-xs"
          >
            <option value="">Anyone</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </SelectNative>
        </label>
      )}
    </div>
  )
}
