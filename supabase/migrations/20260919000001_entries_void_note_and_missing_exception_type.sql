-- Departmental-portal entries that vanish upstream (2026-09-19): detecting
-- when an entry a department already submitted disappears from the portal's
-- own feed. Two independent additions for that feature.

-- ---- a) void_note: required reason for voiding an entry -------------------
-- Mirrors the hub_status_note precedent (20260808000013_entries.sql) -- a
-- plain nullable text column, with "required" enforced at the app layer
-- rather than a NOT NULL/CHECK here, same as hub_status_note.
--
-- NOT a reuse of entries.remark: remark is the Hub-owned enrichment field
-- (renamed from enrichment_note in 20260811000003_entries_restructure.sql)
-- and is a distinct concern from why an entry was voided.
--
-- NOT a restore of void_reason either: that column existed once but was
-- dropped for good in 20260811000003_entries_restructure.sql (§ "lifecycle:
-- void_reason dropped, is_void kept"). void_note is a clean new column, not
-- a rename/revival of the old one.
alter table public.entries add column void_note text;

-- ---- b) new exception type: departmental_entry_missing_from_portal --------
-- Flags a departmental entry that was previously seen on the portal feed but
-- is no longer present there -- i.e. it vanished upstream rather than never
-- having existed.
--
-- Same extend-the-CHECK-constraint pattern as every prior migration touching
-- this table (Postgres has no `ALTER CONSTRAINT ADD VALUE` for a plain
-- CHECK). Base list copied from 20260911000003_manual_flag_reason_exceptions.sql
-- -- the most recent migration to redefine this constraint (confirmed by
-- grepping supabase/migrations/ for `reconciliation_exception_exception_type_check`).
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
    'not_clear','not_visible',
    -- departmental entry present before but now missing from the portal feed (2026-09-19)
    'departmental_entry_missing_from_portal'
  ));
