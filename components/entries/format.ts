import type { BadgeProps } from '@/components/ui/badge'
import {
  hubStatusBadgeVariant as sharedHubStatusBadgeVariant,
  statusBadgeVariant as sharedStatusBadgeVariant,
} from '@/lib/status-badge'

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

/** Hub status is the one dimension with a fixed, known code set (§3.3).
 * Delegates to the shared map in lib/status-badge.ts. */
export function hubStatusBadgeVariant(code: string | null): BadgeProps['variant'] {
  return sharedHubStatusBadgeVariant(code)
}

/** Status / audit status badge colour. Delegates to the shared
 * code-first-with-label-fallback map in lib/status-badge.ts
 * (docs/hub-screen-certification.md §3.3 — unify the two colour maps so
 * "Pending" is no longer grey on Entries and amber on the Dashboard).
 * `code` is optional so the pre-existing label-only call sites keep working. */
export function statusBadgeVariant(label: string | null, code?: string | null): BadgeProps['variant'] {
  return sharedStatusBadgeVariant(code, label)
}
