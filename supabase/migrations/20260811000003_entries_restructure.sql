-- entries restructuring (confirmed 2026-08-11, MASTER-PLAN §3.4). Everything here is a
-- confirmed decision from that conversation EXCEPT the hub_status_id / hub_status_*
-- columns and the hub_status table itself -- those are deliberately left untouched.
-- Folding hub_status into a single status_id (as described) depends on an unfinished
-- answer about how the status-merge switch actually gets triggered (§17 item 4); renaming
-- it now would be guessing at a design that isn't settled, and the app's Day 4-6 screens
-- (entry detail, export, reconciliation) actively read/write those columns today.

-- ---- drop dependent views FIRST ------------------------------------------------------
-- Postgres refuses to alter/drop a column a view still references (confirmed the hard
-- way: this migration failed with "cannot drop column amount_variance ... view
-- v_entry_enriched depends on" when the view drops lived in 20260811000004, which runs
-- after this file). All five recreated in 20260811000004 -- that file's own `drop view
-- if exists` is now redundant but harmless.
drop view if exists public.v_entry_enriched;
drop view if exists public.v_budget_vs_actual;
drop view if exists public.v_vendor_spend;
drop view if exists public.v_zone_spend;
drop view if exists public.v_tenant_main_variance;

-- ---- money: one amount, not two -----------------------------------------------------
-- Confirmed: there is no genuinely separate second figure. The real export's "Tenant
-- Amount"/"Main Amount" columns always carry the same value. Rename preserves all
-- existing data; main_amount is dropped outright (nothing was ever independently in it
-- that tenant_amount didn't already have).
alter table public.entries rename column tenant_amount to amount;
drop index if exists public.entries_variance_idx;
alter table public.entries drop column amount_variance;
alter table public.entries drop column main_amount;

-- ---- status: "Main" renamed to "Audit" everywhere except main_number ------------------
-- (main_number matches the source file's own column name and stays as-is, confirmed).
-- tenant_status_id/main_status_id are the import-side dual status -- entirely orthogonal
-- to the still-open hub_status question, so this half is safe to do now.
alter table public.entries rename column tenant_status_id to status_id;
alter table public.entries rename column main_status_id to audit_status_id;
alter table public.entries rename column tenant_status_raw to status_raw;
alter table public.entries rename column main_status_raw to audit_status_raw;

-- A column rename already updates the index's own definition automatically (Postgres
-- tracks by attribute number, not name) -- only the index's own NAME is stale, so a
-- rename is enough; no need to drop and rebuild it.
alter index public.entries_tenant_status_idx rename to entries_status_idx;
alter index public.entries_main_status_idx rename to entries_audit_status_idx;

-- audit_status gets the same when/who tracking status_id already has (confirmed 2026-08-11).
alter table public.entries add column audit_status_changed_at timestamptz;
alter table public.entries add column audit_status_changed_by uuid references auth.users(id);

-- ---- Hub enrichment: renamed/added columns --------------------------------------------
alter table public.entries rename column head_id to admin_head_id;
alter index if exists entries_head_idx rename to entries_admin_head_idx;

alter table public.entries add column budget_category_id bigint references public.budget_category(id);
create index entries_budget_category_idx on public.entries (budget_category_id)
  where budget_category_id is not null;

alter table public.entries rename column enrichment_note to remark;

alter table public.entries drop column hub_reference;

-- ---- lifecycle: void_reason dropped, is_void kept -------------------------------------
alter table public.entries drop column void_reason;

-- ---- entry_status.source_system: "main" -> "audit" -------------------------------------
-- Constraint dropped, DATA updated, THEN the new stricter constraint added -- adding it
-- before the update fails with a check-violation against the still-'main' rows (found the
-- hard way on the first push attempt).
alter table public.entry_status drop constraint entry_status_source_system_check;
update public.entry_status set source_system = 'audit' where source_system = 'main';
alter table public.entry_status add constraint entry_status_source_system_check
  check (source_system in ('departmental','audit'));

-- ---- import_batch.source_system: "main" -> "audit" --------------------------------------
alter table public.import_batch drop constraint import_batch_source_system_check;
update public.import_batch set source_system = 'audit' where source_system = 'main';
alter table public.import_batch add constraint import_batch_source_system_check
  check (source_system in ('departmental','audit'));

-- ---- status_export_batch.target_system: "main" -> "audit" -------------------------------
alter table public.status_export_batch drop constraint status_export_batch_target_system_check;
update public.status_export_batch set target_system = 'audit' where target_system = 'main';
alter table public.status_export_batch add constraint status_export_batch_target_system_check
  check (target_system in ('departmental','audit','both'));

-- ---- reconciliation_exception.exception_type: renamed values ----------------------------
-- Full value list re-checked against the live constraint before writing this (it carries
-- more values than MASTER-PLAN.md's truncated quote of it) -- only the two renamed values
-- actually change; everything else is preserved verbatim.
alter table public.reconciliation_exception drop constraint reconciliation_exception_exception_type_check;
update public.reconciliation_exception set exception_type = 'ocr_total_vs_amount'
  where exception_type = 'ocr_total_vs_tenant_amount';
update public.reconciliation_exception set exception_type = 'department_vs_audit_variance'
  where exception_type = 'tenant_vs_main_variance';
alter table public.reconciliation_exception add constraint reconciliation_exception_exception_type_check
  check (exception_type in (
    'line_item_tally_mismatch','ocr_total_vs_amount','department_vs_audit_variance',
    'allocation_sum_mismatch','unknown_status_code','id_namespace_collision',
    'duplicate_document_hash','missing_documentation','new_budget_head','new_vendor','other'
  ));
