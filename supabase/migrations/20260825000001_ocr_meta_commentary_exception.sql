-- Meta-commentary backstop for OCR text fields (finding 10.1,
-- docs/pre-deploy-findings-and-plan.md): the model's own commentary about a
-- document's condition/identity (e.g. "Document is partially rotated and
-- heavily skewed; ... This appears to be a bank receipt.") was landing in a
-- data field. lib/extraction-schema.ts's sanitizeExtractionResponse now
-- blanks it via a second pattern (META_COMMENTARY_PATTERN), alongside the
-- existing leaked-tag-syntax backstop, and lib/jobs/handlers/extract.ts
-- raises a new exception_type so a reviewer can tell the two categories
-- apart.
--
-- One new exception type, extending the check constraint 20260821000007 last
-- touched (same pattern every migration touching this constraint has used:
-- drop and re-add with the full list -- Postgres has no `alter constraint
-- add value` for a plain CHECK the way it does for an enum type).
--
-- Built from the LIVE constraint definition, not the original CREATE TABLE --
-- confirmed by grepping every migration under supabase/migrations/ for
-- `reconciliation_exception_exception_type_check` and reading the most
-- recent hit (20260821000007_gst_recipient_compliance.sql) rather than
-- trusting a secondhand list, per the standard set by 20260822000013's own
-- postmortem of a stale-copy constraint rebuild silently dropping values.
-- No migration after 20260821000007 touches this constraint (confirmed by
-- the same grep), so that is the correct base to widen.
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
    'ocr_meta_commentary'
  ));
