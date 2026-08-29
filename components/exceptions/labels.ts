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
  // Phase 3 (20260814000005)
  audit_row_unmatched: 'Audit row unmatched',
  audit_ambiguous_match: 'Audit ambiguous match',
  // vendor_email + own-GSTIN exclusion (20260814000010)
  vendor_gstin_is_own_org: 'Vendor GSTIN is our own org',
  // leaked tool-call tag syntax in OCR text fields
  ocr_leaked_tag_syntax: 'OCR leaked tag syntax',
  // ingest/extraction page-count reconciliation
  page_count_unresolved: 'Page count unresolved',
  page_count_mismatch: 'Page count mismatch',
  // GSTIN checksum guard + per-page extraction failure isolation
  vendor_gstin_invalid_checksum: 'Vendor GSTIN failed checksum',
  page_extraction_failed: 'Page extraction failed',
  // GST recipient-compliance check
  gst_recipient_compliance_missing: 'GST recipient details missing',
  // meta-commentary landing in an OCR text field (finding 10.1)
  ocr_meta_commentary: 'OCR meta-commentary',
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

export const SEVERITY_GROUP_LABELS: Record<string, string> = {
  high: 'High severity',
  medium: 'Medium severity',
  low: 'Low severity',
}

/** Severity values in rank order, for filter dropdowns and sort. */
export const SEVERITY_VALUES = ['high', 'medium', 'low'] as const

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
