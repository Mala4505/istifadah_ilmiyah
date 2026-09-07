-- ============================================================================
-- Wipe every uploaded PDF and its OCR pipeline -- KEEP all entries
-- ============================================================================
-- Companion to scripts/wipe-entries-and-pdfs.sql. That one clears entries too;
-- this one is the "reset the OCR side only, we are about to re-run extraction
-- from scratch" variant (operator request, 2026-09-07).
--
-- Run it in the Supabase SQL Editor -- it executes as the `postgres` role,
-- which bypasses the RLS / REVOKE-DELETE lockdown from
-- 20260808000026_rls_policies.sql (that lockdown only blocks the
-- `authenticated` role the app uses; deletion of source_document is otherwise
-- reachable for the app only through private.delete_source_document, one id at
-- a time -- 20260820000001).
--
-- ----------------------------------------------------------------------------
-- WHAT THIS REMOVES
--   * public.source_document                     -- every uploaded PDF (all match_status,
--                                                   verified extractions included)
--   * public.source_document_assignee            -- every "document assigned to admin X" row
--   * public.document_page                        -- rasterised-page rows
--   * public.ocr_extraction_run                   -- every OCR run + its raw Claude response
--   * public.document_extraction (+ _line_item)   -- every extracted bill + its line items
--   * public.rate_reference                       -- rate benchmarks (derived entirely from
--                                                   line items -- rebuilds on the next OCR pass)
--   * public.flags                                -- all analytics flags (re-run the flags
--                                                   engine afterwards for a fresh set)
--   * doc-scoped public.reconciliation_exception  -- exceptions raised against an extraction
--                                                   or a source_document only
--   * doc-scoped public.job_queue rows            -- queued/failed extract_document / poll_batch
--                                                   / rasterize_retry jobs, so no worker picks
--                                                   up a job for a PDF that no longer exists
--   * storage.objects in 'invoice-documents'      -- METADATA ONLY (see the storage caveat)
--
-- Entry classification set during Review's "Classify" stage is also reset:
--   entries.admin_head_id / zone_id / sub_department_id -> null.
--   NOTE: there is no marker on `entries` recording which tool last set these,
--   so this also clears any admin-head/zone/sub-department set manually via the
--   entries-list "Assign zone / head" bulk action. department_id / budget_head_id
--   (set by the ledger import) are NOT touched. Comment out section 8 below to
--   keep all classification.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS KEEPS
--   * public.entries and every type-detail table (reimbursement_detail, ...)
--   * entry-side / import-side public.reconciliation_exception rows
--   * public.entry_change_log, import_batch, import_row_log, status_export_*,
--     budget_allocation*, all Hub status history
--   * every master / reference table -- department, vendor, vendor_alias,
--     budget_head, budget_category, head, zone, admin_head, cost_center,
--     hub_status, entry_status, item_catalog/family/alias, event + scoping,
--     staff_profile/staff_department, app_settings, auth/login/API-log tables
--
-- ----------------------------------------------------------------------------
-- Ordered DELETEs (not TRUNCATE ... CASCADE): TRUNCATE CASCADE through
-- document_extraction would empty the WHOLE reconciliation_exception table
-- (FK on delete cascade), taking entry/import-side rows with it. Plain deletes
-- in FK order keep that surgical. The order matters for three NO-ACTION edges:
--   rate_reference.line_item_id           -> document_extraction_line_item
--   document_extraction_line_item.page_id -> document_page
--   document_extraction.current_run_id    -> ocr_extraction_run
--
-- This is irreversible. Take a Supabase snapshot first if there is any chance
-- you will want the extractions back.
-- ============================================================================

begin;

-- 1. Rate benchmarks -- must go before the line items they reference.
delete from public.rate_reference;

-- 2. Doc-scoped reconciliation exceptions. BOTH foreign keys are ON DELETE
--    CASCADE -- source_document_id since 20260822000010, document_extraction_id
--    since 20260808000023 -- so steps 4 and 7 below already remove every one of
--    these (page_count_mismatch, page_extraction_failed, line_item_*,
--    *_gstin_*, ocr_*, duplicate_document_hash, ...). Done explicitly first
--    only so the deleted-row counts are legible. Exceptions that carry just an
--    entry_id or import_batch_id (e.g. an entry's own missing_documentation)
--    are left untouched.
delete from public.reconciliation_exception
 where source_document_id is not null
    or document_extraction_id is not null;

-- 3. Line items -> 4. bills -> 5. pages -> 6. runs.
delete from public.document_extraction_line_item;
delete from public.document_extraction;
delete from public.document_page;
delete from public.ocr_extraction_run;

-- 7. Assignments, then the documents themselves.
delete from public.source_document_assignee;
delete from public.source_document;

-- 8. Reset Review "Classify"-stage enrichment on entries. Comment out to keep it.
update public.entries
   set admin_head_id = null,
       zone_id = null,
       sub_department_id = null
 where admin_head_id is not null
    or zone_id is not null
    or sub_department_id is not null;

-- 9. All analytics flags -- re-run the flags engine for a fresh set.
delete from public.flags;

-- 10. Doc-pipeline jobs so a worker can't act on a deleted PDF.
delete from public.job_queue
 where job_type in ('extract_document', 'poll_batch', 'rasterize_retry');

-- 11. Storage metadata for the private documents bucket. THIS DOES NOT FREE THE
--     FILE BYTES -- deleting storage.objects rows via SQL only clears Supabase's
--     catalog. After this commit, also empty the bucket for real, either:
--       * Dashboard -> Storage -> invoice-documents -> select all -> Delete, or
--       * node --env-file=.env scripts/empty-invoice-bucket.mjs
delete from storage.objects
 where bucket_id = 'invoice-documents';

commit;

-- Optional: restart the id sequences so the next upload / run / extraction
-- starts at 1 again. Skip if any external reference (a bookmarked URL, a
-- support ticket) still needs an old numeric id to resolve.
--
-- alter sequence public.source_document_id_seq             restart with 1;
-- alter sequence public.document_page_id_seq               restart with 1;
-- alter sequence public.ocr_extraction_run_id_seq          restart with 1;
-- alter sequence public.document_extraction_id_seq         restart with 1;
-- alter sequence public.document_extraction_line_item_id_seq restart with 1;
-- alter sequence public.rate_reference_id_seq              restart with 1;
-- alter sequence public.flags_id_seq                       restart with 1;
