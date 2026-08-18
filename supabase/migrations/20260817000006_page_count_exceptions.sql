-- Phase 3 (plan.md §4, I1 + I14): two new exception_type values.
--
-- 'page_count_unresolved' — raised at ingest (app/api/documents/ingest/route.ts)
-- when neither the server-side PDF parse nor a client-declared fallback could
-- determine a page count. No document_page rows get created for that upload;
-- previously this was silently absent until (if ever) extraction backfilled
-- it, with nothing to tell a human the ingest-time parse failed.
--
-- 'page_count_mismatch' — raised in lib/jobs/handlers/extract.ts when
-- source_document.page_count (set at ingest, authoritative once known) and
-- the model's own extraction.pages.length disagree. Today the ingest-time
-- count silently wins and any pages the model omitted from pages[] keep a
-- null classification with no warning (I14).
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
    'page_count_unresolved','page_count_mismatch'
  ));
