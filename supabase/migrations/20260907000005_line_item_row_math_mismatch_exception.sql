-- New exception type: 'line_item_row_math_mismatch' (2026-09-07).
--
-- The tally checks in lib/jobs/handlers/extract.ts (runTallyChecks) only
-- compared the SUM of a bill's line items against its subtotal/total. That
-- catches an error that moves the total (a fabricated row, a dropped row) but
-- not a row whose columns were read from different physical lines while
-- staying internally consistent -- the failure mode seen on faint carbon-copy
-- invoices (document_extraction 37 / source_document 10 page 5: descriptions
-- shifted against their numbers across rows 20-22, plus one spliced-in row).
--
-- lineItemRowMathMismatches (lib/extraction-schema.ts) now checks each row's
-- own quantity x rate (+/- a printed % discount) against its amount and
-- raises this LOW-severity advisory naming the exact rows for the reviewer to
-- eyeball. Low, not high: extractionLineItemSchema explicitly allows `amount`
-- to be the line total "as printed when that differs from the arithmetic", so
-- a hit is a prompt to check the page, not a blocker.
--
-- One new value on the CHECK constraint, extended the same way every prior
-- migration touching it has (Postgres has no `ALTER CONSTRAINT ADD VALUE` for
-- a plain CHECK). Base list copied from
-- 20260907000003_buyer_gstin_invalid_checksum_exception.sql -- the most recent
-- migration to redefine this constraint (confirmed by grepping
-- supabase/migrations/ for `reconciliation_exception_exception_type_check`).
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
    'recipient_identity_missing',
    -- checksum-failing recipient GSTIN, kept as-read for the reviewer (2026-09-07)
    'buyer_gstin_invalid_checksum',
    -- per-line quantity x rate vs amount reconciliation (2026-09-07)
    'line_item_row_math_mismatch'
  ));
