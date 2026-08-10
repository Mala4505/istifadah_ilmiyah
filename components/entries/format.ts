import type { BadgeProps } from '@/components/ui/badge'

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
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Hub status is the one dimension with a fixed, known code set (§3.3). */
export function hubStatusBadgeVariant(code: string | null): BadgeProps['variant'] {
  switch (code) {
    case 'awaiting_verification':
      return 'warning'
    case 'awaiting_validation':
      return 'default'
    case 'not_set':
    default:
      return 'outline'
  }
}

/** Status/audit status are import-observed and open-ended (§3.3) — badge
 * color is a best-effort read on the label text rather than a hard-coded
 * code list, since new codes can appear on any import. */
export function statusBadgeVariant(label: string | null): BadgeProps['variant'] {
  const l = (label ?? '').toLowerCase()
  if (l.includes('approve')) return 'success'
  if (l.includes('pending')) return 'outline'
  if (l.includes('sent')) return 'warning'
  return 'secondary'
}
