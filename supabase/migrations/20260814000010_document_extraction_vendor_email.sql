-- Vendor email capture (companion to vendor_phone_ocr/_verified,
-- 20260808000021). The extraction tool schema (lib/extraction-schema.ts)
-- and Claude's system prompt (lib/claude-client.ts) are being extended in
-- the same change to read it off the invoice, and the review screen
-- (components/review/extraction-form.tsx) gets a matching "Email" field
-- next to "Phone" -- this column pair is what both write to.
alter table public.document_extraction
  add column vendor_email_ocr text,
  add column vendor_email_verified text;

-- New exception type: 'vendor_gstin_is_own_org'. Raised by
-- lib/jobs/handlers/extract.ts when the extracted vendor_gstin matches the
-- org's own GSTIN (COMMUNITY_GSTIN, lib/env.server.ts) -- i.e. the model
-- read the recipient's GSTIN off the page instead of the seller's. The
-- write nulls out vendor_gstin_ocr in that case, so this low-severity
-- exception is what tells a reviewer *why* GSTIN is blank instead of
-- leaving them to assume OCR simply missed it.
--
-- While rebuilding this constraint, also fixing a regression: 20260811000003
-- renamed 'ocr_total_vs_tenant_amount' -> 'ocr_total_vs_amount' and
-- 'tenant_vs_main_variance' -> 'department_vs_audit_variance' (see that
-- migration), but 20260814000005 (Phase 3) dropped and recreated this same
-- constraint from a stale value list, silently reverting both renames.
-- lib/jobs/handlers/extract.ts has been raising 'ocr_total_vs_amount' ever
-- since, which would violate the (reverted) constraint. Using the correct,
-- current names here instead of copying 20260814000005's stale list.
alter table public.reconciliation_exception drop constraint if exists reconciliation_exception_exception_type_check;
alter table public.reconciliation_exception add constraint reconciliation_exception_exception_type_check
  check (exception_type in (
    'line_item_tally_mismatch','ocr_total_vs_amount','department_vs_audit_variance',
    'allocation_sum_mismatch','unknown_status_code','id_namespace_collision',
    'duplicate_document_hash','missing_documentation','new_budget_head','new_vendor','other',
    -- Phase 3 (20260814000005)
    'audit_row_unmatched','audit_ambiguous_match',
    -- vendor_email + own-GSTIN exclusion
    'vendor_gstin_is_own_org'
  ));
