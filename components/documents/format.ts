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
