-- ============================================================================
-- Wipe all entries and all PDFs (both modules: Departmental + Audit)
-- ============================================================================
-- Run this in the Supabase SQL Editor (it runs as the `postgres` role, which
-- bypasses the RLS/REVOKE-DELETE lockdown from 20260808000026_rls_policies.sql
-- -- that lockdown only blocks the `authenticated` role used by the app).
--
-- Scope: every financial entry (public.entries -- the single table both the
-- Departmental and Audit/"Main" modules import into, MASTER-PLAN.md §3.4) and
-- every uploaded PDF (public.source_document + the storage.objects rows in
-- the 'invoice-documents' bucket), plus every table that hangs off either of
-- those: OCR runs/extractions/line items, reconciliation exceptions, the
-- entry change log, flags, rate_reference, status_export_row, import_row_log,
-- job_queue, and -- per your choice to also reset batch history --
-- import_batch, status_export_batch, budget_allocation,
-- department_budget_allocation and sub_department_budget_allocation (these
-- last three are pulled in only because they carry a NOT NULL, non-cascading
-- FK to import_batch -- you can't empty import_batch while they still point
-- to it).
--
-- NOT touched: master/reference data -- department, vendor, vendor_alias,
-- budget_head, budget_category, head, zone, hub_status, entry_status,
-- item_catalog/item_family/item_alias, event and its scoping tables,
-- staff_profile/staff_department, scrape_token, app_settings, and all
-- auth/login/API-log tables.
--
-- RESTART IDENTITY resets every wiped table's bigint id sequence back to 1 --
-- appropriate for a full reset, but means any external reference to an old
-- numeric id (a bookmarked URL, a support ticket) stops resolving.
--
-- IMPORTANT caveat on the storage delete: removing rows from storage.objects
-- via SQL only clears Supabase's metadata catalog -- it does NOT reliably
-- delete the underlying file bytes from the storage backend. After running
-- this, also empty the 'invoice-documents' bucket from
-- Dashboard -> Storage (select all -> Delete), or via the JS/CLI storage API,
-- to actually reclaim the space.
--
-- This is irreversible. There is no undo, no soft-delete, no trash. Take a
-- Supabase backup/snapshot first if there is any chance you'll want this data
-- back.
-- ============================================================================

begin;

truncate table
  public.rate_reference,
  public.flags,
  public.reconciliation_exception,
  public.document_extraction_line_item,
  public.document_extraction,
  public.document_page,
  public.ocr_extraction_run,
  public.entry_change_log,
  public.status_export_row,
  public.import_row_log,
  public.source_document,
  public.entries,
  public.budget_allocation,
  public.department_budget_allocation,
  public.sub_department_budget_allocation,
  public.status_export_batch,
  public.import_batch,
  public.job_queue
restart identity cascade;

-- Metadata for every PDF in the private documents bucket. See the storage
-- caveat above -- this does not by itself free the physical storage.
delete from storage.objects
 where bucket_id = 'invoice-documents';

commit;
