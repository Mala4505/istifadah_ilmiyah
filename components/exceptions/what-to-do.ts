/**
 * Per-exception-type "what to do" hint + destination link (plan §4.1).
 * Today `ResolveExceptionDialog` is pure bookkeeping — a note plus
 * Resolved/Dismissed, nothing routes to the thing that needs fixing. This
 * table is the fix: a one-line hint for every type, and (where a real
 * destination exists) a link built from the id fields already threaded
 * through from `reconciliation_exception` (entry_id, document_extraction_id,
 * source_document_id — see exceptions-table.tsx's `ExceptionRow`).
 *
 * Destination reasoning (see docs/pre-deploy-findings-and-plan.md §4.1):
 * - "that bill in /review" resolves to `/review?id=<document_extraction_id>`
 *   (confirmed against app/(app)/review/page.tsx: `?id=` is matched against
 *   `document_extraction_id`, not `source_document_id`). Only buildable when
 *   that id is non-null on the row.
 * - "that document in /review" (page_count_mismatch/unresolved) and "that
 *   page in /review" (page_extraction_failed): /review has no document- or
 *   page-level route, only bill-level via `?id=`. These exceptions are
 *   raised before/independent of any single bill's extraction, so
 *   document_extraction_id is null on essentially every row of these types
 *   (20260822000010's backfill only ever populates source_document_id for
 *   them). Pragmatic fallback: link to `/documents` (the inbox) — that's
 *   where a document's bills and its re-run-extraction action live. If a
 *   row's document_extraction_id happens to be set, prefer the precise
 *   /review link instead.
 * - "the earlier document" (duplicate_document_hash): the row's own
 *   source_document_id is the NEWLY uploaded document (20260822000010's
 *   migration comment: dedup_key is keyed on the new document's id, and the
 *   description names the earlier one only as free text). The earlier
 *   document's id is only recoverable by regexing `description`, and even
 *   then there is no document-detail route to land on (only `/documents`,
 *   the inbox, with no id/query-param support) — so parsing it would buy a
 *   ref, not a destination. Not worth it: link to `/documents` and let the
 *   reviewer compare by hand, same as the other document-level fallbacks.
 * - "the entry" (id_namespace_collision): `entry_id`, same link the Entry
 *   column already renders.
 * - `/import`, `/settings`: static, no params (neither route reads a query
 *   param for this — confirmed by inspection).
 *
 * Types with no destination specified by the plan (department_vs_audit_
 * variance, allocation_sum_mismatch, unknown_status_code, missing_
 * documentation, other, audit_ambiguous_match, ocr_leaked_tag_syntax,
 * ocr_meta_commentary, vendor_gstin_invalid_checksum) get a sensible
 * one-liner and no button, rather than a guessed link.
 */

export interface ExceptionActionRow {
  exception_type: string
  entry_id: number | null
  document_extraction_id: number | null
  source_document_id: number | null
}

export interface ExceptionAction {
  whatToDo: string
  destination?: { href: string; label: string }
}

function reviewBillLink(row: ExceptionActionRow): { href: string; label: string } | undefined {
  return row.document_extraction_id !== null
    ? { href: `/review?id=${row.document_extraction_id}`, label: 'Open bill in Review' }
    : undefined
}

/** Prefer the precise bill link when we happen to have it; otherwise the inbox. */
function reviewBillOrDocumentsLink(row: ExceptionActionRow): { href: string; label: string } | undefined {
  const billLink = reviewBillLink(row)
  if (billLink) return billLink
  return row.source_document_id !== null ? { href: '/documents', label: 'Open Documents inbox' } : undefined
}

const STATIC_WHAT_TO_DO: Record<string, string> = {
  department_vs_audit_variance: 'Compare the Departmental-side and Audit-portal figures for this entry.',
  allocation_sum_mismatch: 'Check how this budget head’s utilised amount was allocated across its entries.',
  unknown_status_code: 'A status code from the source file wasn’t recognised — check the import file directly.',
  missing_documentation: 'Attach the supporting bill or document for this entry.',
  other: 'Read the description for details on what to check.',
  audit_ambiguous_match: 'Multiple Audit-portal rows could match this entry — confirm the right one manually.',
  ocr_leaked_tag_syntax: 'A field was blanked because it contained stray formatting artefacts — re-check it manually.',
  ocr_meta_commentary:
    'A field was blanked because it looked like the model’s own commentary about the document rather than real content — re-check it manually.',
  vendor_gstin_invalid_checksum: 'The vendor GSTIN failed its checksum — it was likely misread; correct it.',
}

export function getExceptionAction(row: ExceptionActionRow): ExceptionAction {
  switch (row.exception_type) {
    case 'line_item_tally_mismatch':
      return { whatToDo: 'Re-check the line items against the bill total.', destination: reviewBillLink(row) }
    case 'ocr_total_vs_amount':
      return { whatToDo: 'Confirm which figure is right — the bill or the ledger.', destination: reviewBillLink(row) }
    case 'audit_row_unmatched':
      return {
        whatToDo: 'The Departmental row hasn’t arrived yet; re-run the import.',
        destination: { href: '/import', label: 'Open Import' },
      }
    case 'duplicate_document_hash':
      return {
        whatToDo: 'Compare against the earlier upload with the same file hash.',
        destination: row.source_document_id !== null ? { href: '/documents', label: 'Open Documents inbox' } : undefined,
      }
    case 'page_extraction_failed':
      return { whatToDo: 'Re-OCR that page.', destination: reviewBillOrDocumentsLink(row) }
    case 'page_count_mismatch':
    case 'page_count_unresolved':
      return {
        whatToDo: 'Check for pages the model didn’t classify.',
        destination: reviewBillOrDocumentsLink(row),
      }
    case 'gst_recipient_compliance_missing':
      return {
        whatToDo: 'Buyer GSTIN or name is missing or wrong on the bill.',
        destination: reviewBillLink(row),
      }
    case 'vendor_gstin_is_own_org':
      return {
        whatToDo: 'OCR read our own GSTIN as the vendor’s — correct it.',
        destination: reviewBillLink(row),
      }
    case 'id_namespace_collision':
      return {
        whatToDo: 'Two source systems reused an identifier.',
        destination: row.entry_id !== null ? { href: `/entries/${row.entry_id}`, label: 'Open entry' } : undefined,
      }
    case 'new_vendor':
      return {
        whatToDo: 'Confirm the auto-created vendor row.',
        destination: { href: '/settings', label: 'Open Settings' },
      }
    case 'new_budget_head':
      return {
        whatToDo: 'Confirm the auto-created budget head row.',
        destination: { href: '/settings', label: 'Open Settings' },
      }
    default:
      return { whatToDo: STATIC_WHAT_TO_DO[row.exception_type] ?? 'Review the description for details.' }
  }
}
