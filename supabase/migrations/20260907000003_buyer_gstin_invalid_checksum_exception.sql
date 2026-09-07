-- New exception type: 'buyer_gstin_invalid_checksum' (2026-09-07).
--
-- The extract handler (lib/jobs/handlers/extract.ts) used to NULL a
-- checksum-failing buyer_gstin, mirroring an early vendor_gstin rule that was
-- itself reversed on 2026-08-29 (feedback: a checksum failure is almost
-- always one mis-read character, and blanking the field forces a full retype
-- and makes a plainly-printed GSTIN read as "missing"). buyer_gstin now
-- follows the same rule as vendor_gstin: keep the raw value, and raise this
-- low-severity exception so the reviewer knows to fix the character and save.
-- lib/actions/review.ts's saveVerification auto-resolves it once the verified
-- value passes its checksum, exactly like vendor_gstin_invalid_checksum.
--
-- One new value on the CHECK constraint, extended the same way every prior
-- migration touching it has (Postgres has no `ALTER CONSTRAINT ADD VALUE` for
-- a plain CHECK). Base list copied from
-- 20260829000001_recipient_identity_exception.sql -- the most recent migration
-- to redefine this constraint (confirmed by grepping supabase/migrations/ for
-- `reconciliation_exception_exception_type_check`).
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
    'buyer_gstin_invalid_checksum'
  ));
