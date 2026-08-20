-- Two new reconciliation_exception types, extending the check constraint
-- 20260817000006 last touched (same pattern: drop and re-add with the full
-- list, since Postgres has no `alter constraint add value` for a plain CHECK
-- the way it does for an enum type).
--
-- 'vendor_gstin_invalid_checksum' — the GSTIN checksum guard added to
-- lib/jobs/handlers/extract.ts alongside the existing 'vendor_gstin_is_own_org'
-- backstop. Both exist for the same reason and sit right next to each other in
-- that file: the model occasionally misreads a GSTIN, and `lib/analytics/gstin.ts`'s
-- `validateGstin` (already written, already unit-tested, previously only wired
-- into the compliance analytics pass) can catch a misread with certainty,
-- because the GSTIN's own last character is a checksum computed over the
-- other fourteen. A GSTIN that fails this check is not a matter of judgment —
-- it is definitionally wrong, mis-typed or mis-read.
--
-- 'page_extraction_failed' — per-page extraction (lib/pdf.ts's splitPdfPage,
-- lib/jobs/handlers/extract.ts) means one page's Claude call can fail (a
-- timeout, a rate limit, a transient API error) without losing the rest of
-- the document, which is the whole point of splitting. That page's failure
-- still needs to be visible to a human rather than silently absent from the
-- document — this is what records it.
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
    'vendor_gstin_invalid_checksum','page_extraction_failed'
  ));
