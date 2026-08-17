-- New exception_type: 'ocr_leaked_tag_syntax' (hub-refinements-plan.md §3b).
--
-- Real example observed in production: a GSTIN field showed
-- `</antml.parameter><parameter name="vendor_phone">+91 9925755` -- Claude's own
-- internal tool-call formatting, leaked into the field's text content.
-- `strict: true` tool calling (lib/claude-client.ts) guarantees the JSON
-- *structure* is valid but not what text ends up *inside* a string field, so
-- a momentary hallucination of the model's own formatting can end up as
-- literal field content.
--
-- lib/jobs/handlers/extract.ts now scans every extracted header and
-- line-item text field for tag-shaped content (sanitizeLeakedTagSyntax*,
-- lib/extraction-schema.ts) before persisting. Any field that matches is
-- blanked (same "blank it, don't write corrupted text" posture as
-- 'vendor_gstin_is_own_org', 20260814000010) and this single low-severity
-- exception is raised per document_extraction naming which field(s) were
-- blanked, rather than one exception per field.
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
    'ocr_leaked_tag_syntax'
  ));
