// Shared formatting helpers for the reporting screens (Dashboard, Reconciliation,
// Reports — MASTER-PLAN §5 rows 2, 9, 10). Kept framework-free so it can be
// imported from server or client components without pulling in React.

/** Full INR figure with Indian digit grouping, e.g. "₹2,32,46,861". */
export function formatINR(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value)
}

/** Compact INR figure for dashboard tiles and bar labels, e.g. "₹2.32 Cr". */
export function formatINRCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e7) return `₹${(value / 1e7).toFixed(2)} Cr`
  if (abs >= 1e5) return `₹${(value / 1e5).toFixed(2)} L`
  if (abs >= 1e3) return `₹${(value / 1e3).toFixed(1)}k`
  return formatINR(value)
}

/** Plain integer/percentage formatting with Indian grouping and an em dash fallback. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat('en-IN').format(value)
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(value)}%`
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Title-cases a snake_case code for display, e.g. "allocation_sum_mismatch" -> "Allocation sum mismatch". */
export function humanizeCode(code: string | null | undefined): string {
  if (!code) return '—'
  const spaced = code.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
