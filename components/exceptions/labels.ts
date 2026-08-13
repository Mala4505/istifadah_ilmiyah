/** Human-readable labels for reconciliation_exception.exception_type (MASTER-PLAN §3.10). */
export const EXCEPTION_TYPE_LABELS: Record<string, string> = {
  line_item_tally_mismatch: 'Line-item tally mismatch',
  ocr_total_vs_amount: 'OCR total vs amount',
  department_vs_audit_variance: 'Department vs Audit variance',
  allocation_sum_mismatch: 'Allocation sum mismatch',
  unknown_status_code: 'Unknown status code',
  id_namespace_collision: 'ID namespace collision',
  duplicate_document_hash: 'Duplicate document hash',
  missing_documentation: 'Missing documentation',
  new_budget_head: 'New budget head',
  new_vendor: 'New vendor',
  other: 'Other',
}

/** In CHECK-constraint order (MASTER-PLAN §3.10 migration). */
export const EXCEPTION_TYPES = Object.keys(EXCEPTION_TYPE_LABELS)

export function exceptionTypeLabel(type: string): string {
  return EXCEPTION_TYPE_LABELS[type] ?? type
}

export function severityBadgeVariant(severity: string): 'destructive' | 'warning' | 'secondary' {
  switch (severity) {
    case 'high':
      return 'destructive'
    case 'medium':
      return 'warning'
    default:
      return 'secondary'
  }
}

const SEVERITY_GROUP_LABELS: Record<string, string> = {
  high: 'High severity',
  medium: 'Medium severity',
  low: 'Low severity',
}

export function severityGroupLabel(severity: string): string {
  return SEVERITY_GROUP_LABELS[severity] ?? `${severity} severity`
}

export function severityRank(severity: string): number {
  switch (severity) {
    case 'high':
      return 3
    case 'medium':
      return 2
    case 'low':
      return 1
    default:
      return 0
  }
}
