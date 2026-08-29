-- Recipient-identity check (review-page-layout-redesign-plan.md §12,
-- recipient-identity expansion confirmed with the user 2026-08-29): the
-- community's own GSTIN and name must appear on EVERY bill it files, not
-- only on GST tax invoices. The existing `gst_recipient_compliance_missing`
-- exception stays `high` and GST-charged-only (real ITC-claim stake); this
-- new type covers the same fields missing on a non-tax bill at `low`
-- severity -- a house rule for filed paperwork, sitting alongside the other
-- advisory OCR-quality flags. Raised in lib/jobs/handlers/extract.ts from
-- the same checkGstRecipientCompliance() call, branched on its `taxInvoice`
-- flag.
--
-- One new exception type, extending the check constraint the same way every
-- migration touching it has: drop and re-add with the full list (Postgres
-- has no `alter constraint add value` for a plain CHECK the way it does for
-- an enum type). Built from the LIVE constraint definition --
-- 20260827000001_entries_type_detail_tables.sql is the most recent migration
-- to touch this constraint (confirmed by grepping every migration under
-- supabase/migrations/ for `reconciliation_exception_exception_type_check`),
-- so that is the correct base to widen.
alter table public.reconciliation_exception drop constraint if exists reconciliation_exception_exception_type_check;
alter table public.reconciliation_exception add constraint reconciliation_exception_exception_type_check
  check (exception_type in (
    'line_item_tally_mismatch','ocr_total_vs_amount','department_vs_audit_variance',
    'allocation_sum_mismatch','unknown_status_code','id_namespace_collision',
    'duplicate_document_hash','missing_documentation','new_budget_head','new_vendor','other',
    -- Phase 3 (20260814000005)
    'audit_row_unmatched','audit_ambiguous_match',
    -- vendor_email + own-GSTIN exclusion (20260814000010)
    'vendor_gstin_is_own_org',
    -- leaked tool-call tag syntax in OCR text fields (§3b)
    'ocr_leaked_tag_syntax',
    -- ingest/extraction page-count reconciliation (Phase 3, I1 + I14)
    'page_count_unresolved','page_count_mismatch',
    -- GSTIN checksum guard + per-page extraction failure isolation
    'vendor_gstin_invalid_checksum','page_extraction_failed',
    -- GST recipient-compliance check (plan §12)
    'gst_recipient_compliance_missing',
    -- meta-commentary landing in an OCR text field (finding 10.1)
    'ocr_meta_commentary',
    -- entries type-split: bookmarklet-detected tab kind vs UBBL-prefix rule disagree
    'entry_type_kind_mismatch',
    -- our own GSTIN/name missing on a non-tax bill (plan §12 recipient-identity expansion)
    'recipient_identity_missing'
  ));
