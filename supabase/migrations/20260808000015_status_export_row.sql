-- Ordered after entries: this table FKs to it.
create table public.status_export_row (
  id bigint generated always as identity primary key,
  status_export_batch_id bigint not null references public.status_export_batch(id) on delete cascade,
  entry_id bigint not null references public.entries(id),
  ubbl_number text not null,             -- snapshotted: the export must not depend on a later edit
  main_number text,
  hub_status_code text not null,
  hub_status_note text,
  changed_at timestamptz not null,
  changed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (status_export_batch_id, entry_id)
);
create index status_export_row_entry_idx on public.status_export_row (entry_id);
create index status_export_row_changed_by_idx on public.status_export_row (changed_by)
  where changed_by is not null;

-- Re-export is explicit, not automatic (§3.7). If someone changes a status again after
-- export, entries.hub_status_exported_at resets to null and the entry re-enters the
-- queue (see entries_pending_export_idx, 20260808000014). The previous
-- status_export_row stays as a permanent record of what was sent and when -- a
-- delivered export is never rewritten, and is retained indefinitely (§4.4d).
