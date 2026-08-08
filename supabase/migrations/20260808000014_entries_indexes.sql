-- Indexes from §3.4, verbatim.
create index entries_date_idx on public.entries (date);
create index entries_dept_bh_idx on public.entries (department_id, budget_head_id);
create index entries_head_idx on public.entries (head_id) where head_id is not null;
create index entries_zone_idx on public.entries (zone_id) where zone_id is not null;
create index entries_vendor_idx on public.entries (vendor_id);
create index entries_tenant_status_idx on public.entries (tenant_status_id, date);
create index entries_main_number_idx on public.entries (main_number) where main_number is not null;
create index entries_invoice_number_idx on public.entries (invoice_number);
create index entries_batch_idx on public.entries (import_batch_id);
create index entries_variance_idx on public.entries (amount_variance)
  where amount_variance is not null and amount_variance <> 0;
create index entries_settles_idx on public.entries (settles_entry_id) where settles_entry_id is not null;
create index entries_hub_status_idx on public.entries (hub_status_id);
-- the export queue: everything set in the Hub that hasn't been pushed out yet
create index entries_pending_export_idx on public.entries (hub_status_changed_at)
  where hub_status_exported_at is null and hub_status_id <> 1;

-- Supplementary indexes, beyond §3.4's inline snippet, to satisfy the "every FK
-- indexed" convention (§3 preamble) for the remaining FK columns on entries that the
-- snippet's composite/partial indexes don't already cover as a leading column.
create index entries_budget_head_idx on public.entries (budget_head_id) where budget_head_id is not null;
create index entries_main_status_idx on public.entries (main_status_id) where main_status_id is not null;
create index entries_hub_status_export_batch_idx on public.entries (hub_status_export_batch_id)
  where hub_status_export_batch_id is not null;
create index entries_created_by_idx on public.entries (created_by) where created_by is not null;
create index entries_updated_by_idx on public.entries (updated_by) where updated_by is not null;
create index entries_hub_status_changed_by_idx on public.entries (hub_status_changed_by)
  where hub_status_changed_by is not null;

-- Deferred FK, now that public.entries exists: public.import_row_log.entry_id could not
-- reference it at creation time (20260808000011_import_batch_and_row_log.sql), because
-- this table is created after it per §10's file ordering. Add the constraint now.
alter table public.import_row_log
  add constraint import_row_log_entry_id_fkey
  foreign key (entry_id) references public.entries(id);
