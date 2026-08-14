/** Local formatting helpers, matching components/entries/format.ts's
 *  conventions — kept as a separate copy so the documents feature has no
 *  cross-feature import (each screen folder is self-contained, per the
 *  existing components/<feature>/format.ts pattern). */

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
})

export function formatMoney(value: number | null): string {
  if (value === null || value === undefined) return '—'
  return inrFormatter.format(value)
}

export function formatDate(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Percent string for a 0..1 match score, e.g. "87%". */
export function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`
}

/** Compact relative-time string for the inbox stage tracker, e.g. "6m ago", "2h ago", "just now". */
export function formatElapsed(value: string): string {
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return '—'
  const ms = Math.max(0, Date.now() - then)
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
