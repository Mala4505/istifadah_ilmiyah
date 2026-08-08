import { Badge, type BadgeProps } from '@/components/ui/badge'

/** Maps an import_row_log.action value to a Badge variant + human label. */
const ACTION_DISPLAY: Record<string, { label: string; variant: NonNullable<BadgeProps['variant']> }> = {
  inserted: { label: 'Inserted', variant: 'success' },
  updated: { label: 'Updated', variant: 'warning' },
  unchanged: { label: 'Unchanged', variant: 'secondary' },
  new_budget_head: { label: 'New budget head', variant: 'info' },
  new_vendor: { label: 'New vendor', variant: 'info' },
  skipped_header: { label: 'Skipped (header)', variant: 'outline' },
  skipped_total: { label: 'Skipped (grand total)', variant: 'outline' },
  skipped_no_ubbl: { label: 'Skipped (no UBBL)', variant: 'outline' },
  error: { label: 'Error', variant: 'destructive' },
}

export function RowLogBadge({ action }: { action: string }) {
  const display = ACTION_DISPLAY[action] ?? { label: action, variant: 'outline' as const }
  return <Badge variant={display.variant}>{display.label}</Badge>
}

/** Same label/variant lookup as RowLogBadge, for building count summaries. */
export function actionDisplay(action: string): { label: string; variant: NonNullable<BadgeProps['variant']> } {
  return ACTION_DISPLAY[action] ?? { label: action, variant: 'outline' }
}

/** Same mapping, for the batch-status badge (import_batch.status). */
const STATUS_DISPLAY: Record<string, { label: string; variant: NonNullable<BadgeProps['variant']> }> = {
  processing: { label: 'Processing', variant: 'secondary' },
  completed: { label: 'Completed', variant: 'success' },
  completed_with_exceptions: { label: 'Completed (exceptions)', variant: 'warning' },
  failed: { label: 'Failed', variant: 'destructive' },
}

export function BatchStatusBadge({ status }: { status: string }) {
  const display = STATUS_DISPLAY[status] ?? { label: status, variant: 'outline' as const }
  return <Badge variant={display.variant}>{display.label}</Badge>
}
