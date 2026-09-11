-- Preset reasons for the Review page's manual "Flag exception" button
-- (2026-09-11, user request): reviewers flagging a bad scan currently have no
-- option but a blank free-text note, which always lands in the generic
-- 'other' bucket -- unhelpful on the toolbar badge and on /exceptions, which
-- both just show "other" with the actual reason buried in a hover tooltip.
--
-- Two new exception types cover the two concrete reasons the user asked for
-- ("not clear", "not visible"); "Other" keeps using the existing 'other'
-- type with a required note, unchanged. flagReviewException
-- (lib/actions/review.ts) now takes a `reason` param that maps directly to
-- one of these three exception_type values.
--
-- Same extend-the-CHECK-constraint pattern as every prior migration touching
-- this table (Postgres has no `ALTER CONSTRAINT ADD VALUE` for a plain
-- CHECK). Base list copied from
-- 20260907000005_line_item_row_math_mismatch_exception.sql -- the most
-- recent migration to redefine this constraint (confirmed by grepping
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
    'line_item_row_math_mismatch',
    -- manual Review-page flag reasons (2026-09-11)
    'not_clear','not_visible'
  ));
