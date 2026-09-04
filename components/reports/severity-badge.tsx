import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Status-role colors, not the categorical chart palette (dataviz skill,
// "Status colors are reserved ... never reused for 'series N'"). Sub-3:1
// light-surface contrast pairs (amber) always ship with the text label next
// to them here, never color alone.
const SEVERITY_STYLES: Record<string, string> = {
  high: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  low: 'bg-secondary text-secondary-foreground',
}

export function SeverityBadge({ severity }: { severity: string | null | undefined }) {
  const key = severity && severity in SEVERITY_STYLES ? severity : 'low'
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize',
        SEVERITY_STYLES[key]
      )}
    >
      {severity ?? 'unknown'}
    </span>
  )
}

// Cluster-review status (duplicate-payment register and any sibling finding
// that tracks an open/confirmed/dismissed lifecycle). Same reserved status
// roles as SeverityBadge — confirmed = red (a real double charge), open =
// amber (unresolved), dismissed = neutral (checked, fine) — and, like every
// pill here, the full word rides inside so colour is never the only signal
// (§6 "state in shape, not text").
const CLUSTER_STATUS_STYLES: Record<string, string> = {
  open: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  confirmed: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  dismissed: 'bg-secondary text-secondary-foreground',
}

const CLUSTER_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed',
}

export function ClusterStatusBadge({
  status,
  label,
}: {
  status: string | null | undefined
  label?: string
}) {
  const key = status && status in CLUSTER_STATUS_STYLES ? status : 'open'
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        CLUSTER_STATUS_STYLES[key]
      )}
    >
      {label ?? CLUSTER_STATUS_LABELS[key]}
    </span>
  )
}

/** Generic amber "this row needs a look" pill — the table-cell counterpart to
 *  a chart's warning glyph, so a finding survives a column scan and greyscale
 *  (the word carries it, not the colour). */
export function AttentionPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex w-fit items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
      {children}
    </span>
  )
}

const AGE_BUCKET_STYLES: Record<string, string> = {
  '0-2': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  '3-7': 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  '8+': 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
}

export function AgeBucketBadge({ bucket }: { bucket: string | null | undefined }) {
  const key = bucket ?? '0-2'
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        AGE_BUCKET_STYLES[key] ?? AGE_BUCKET_STYLES['0-2']
      )}
    >
      {key} days
    </span>
  )
}
