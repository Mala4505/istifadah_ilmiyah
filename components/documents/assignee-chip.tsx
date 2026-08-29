'use client'

import { cn } from '@/lib/utils'
import type { DocumentAssignee } from '@/lib/assignment/queries'

/**
 * Assignment chips for the /documents inbox ("dividing the document inbox",
 * 2026-08-29). One small initials avatar per assignee, or a dashed
 * "Unassigned" pill for a document still in the shared pool.
 *
 * `staffInitials` is duplicated here rather than imported from
 * lib/assignment/queries.ts: that module transitively pulls in
 * `next/headers` (via lib/events/current.ts), so importing anything runtime
 * from it into a client component drags server-only code into the bundle.
 * The type import below is erased at compile time, so it's safe.
 */

/** "Fatima Iqbal" -> "FI", "Rehan" -> "RE". Mirrors lib/assignment/queries.ts. */
export function staffInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '??'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

/**
 * A small, stable per-person tint so two assignees on the same document read
 * as two people at a glance. Light-mode-first pairs with a dark-mode variant;
 * the hash is on the staff id so a person keeps the same colour everywhere.
 */
const AVATAR_TINTS = [
  'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
  'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
  'bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200',
] as const

function tintFor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return AVATAR_TINTS[Math.abs(hash) % AVATAR_TINTS.length]!
}

export function StaffAvatar({
  displayName,
  seed,
  className,
}: {
  displayName: string
  /** Colour seed — the staff id where available, so the tint is stable per person. Falls back to the name. */
  seed?: string
  className?: string
}) {
  return (
    <span
      title={displayName}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ring-1 ring-background',
        tintFor(seed ?? displayName),
        className
      )}
    >
      {staffInitials(displayName)}
    </span>
  )
}

/** How many avatars to show before collapsing the rest into a "+N". */
const MAX_VISIBLE = 3

export function AssigneeChip({ assignees }: { assignees: DocumentAssignee[] }) {
  if (assignees.length === 0) {
    return (
      <span className="inline-flex items-center rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
        Unassigned
      </span>
    )
  }

  const visible = assignees.slice(0, MAX_VISIBLE)
  const overflow = assignees.length - visible.length

  return (
    <span
      className="inline-flex items-center"
      title={assignees.map((a) => a.displayName).join(', ')}
    >
      <span className="flex -space-x-1.5">
        {visible.map((a) => (
          <StaffAvatar key={a.staffId} displayName={a.displayName} seed={a.staffId} />
        ))}
      </span>
      {overflow > 0 && (
        <span className="ml-1 text-[11px] font-medium text-muted-foreground">+{overflow}</span>
      )}
    </span>
  )
}
