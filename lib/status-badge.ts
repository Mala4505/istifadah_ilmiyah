import type { BadgeProps } from '@/components/ui/badge'

/**
 * One badge-variant map keyed by semantic state, shared across every status
 * dimension the app renders — Status, Audit status, and Hub status alike
 * (docs/hub-screen-certification.md §5 item 3.3, docs/pre-deploy-findings-and-plan.md §7.4).
 *
 * Before this existed there were two independent maps: the Dashboard's
 * code-first `semanticStatusState` (components/dashboard/status-count-card.tsx)
 * and the Entries table's label-sniffing `statusBadgeVariant`
 * (components/entries/format.ts). "Pending" rendered grey on Entries and
 * amber on the Dashboard. This is the single source of truth both now
 * delegate to.
 *
 * Kept framework-free (only a type import) so it can be used from server or
 * client components without pulling in React.
 *
 * Driven by code first (the small, real code set: not_set / pending /
 * sent_main / approved / tax_invoice_upload_pending_paid / paid for Status &
 * Audit status; not_set / awaiting_verification / awaiting_validation for Hub
 * status — see 20260808000009_entry_status.sql, 20260814000008_audit_status_labels.sql,
 * 20260808000010_hub_status.sql), with a label-substring fallback for
 * whatever an unseen future status code turns out to be (the Departmental /
 * Audit imports auto-insert any status code they haven't seen before).
 *
 * Order matters: 'Tax Invoice Upload Pending (Paid)' contains both "pending"
 * and "(Paid)" but is NOT terminal (is_terminal=false) — checking the
 * in-progress state first keeps it out of the terminal/positive bucket.
 */
export type SemanticStatusState = 'not-set' | 'positive' | 'warning' | 'neutral'

const SEMANTIC_STATUS_BADGE_VARIANT: Record<SemanticStatusState, BadgeProps['variant']> = {
  'not-set': 'outline',
  positive: 'success',
  warning: 'warning',
  neutral: 'secondary',
}

export function semanticStatusState(code: string | null | undefined, label: string | null | undefined): SemanticStatusState {
  const c = (code ?? '').toLowerCase()
  const l = (label ?? '').toLowerCase()
  if (c === 'not_set' || l === 'not set' || l === '') return 'not-set'
  if (c.startsWith('awaiting') || /pending|sent|awaiting|progress/.test(l)) return 'warning'
  if (/approve|paid|complete|done|verified|validated/.test(l)) return 'positive'
  return 'neutral'
}

/**
 * The one function every status dimension should call. `code` is preferred
 * (stable, small set); `label` is the fallback for unseen codes.
 */
export function statusBadgeVariant(
  code: string | null | undefined,
  label: string | null | undefined
): BadgeProps['variant'] {
  return SEMANTIC_STATUS_BADGE_VARIANT[semanticStatusState(code, label)]
}

/** Hub status is the one dimension with a fixed, known code set. */
export function hubStatusBadgeVariant(code: string | null | undefined): BadgeProps['variant'] {
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
