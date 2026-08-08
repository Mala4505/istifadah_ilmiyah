-- Ordered before entries: entries.hub_status_export_batch_id FKs to this table.
create table public.status_export_batch (
  id bigint generated always as identity primary key,
  target_system text not null check (target_system in ('departmental','main','both')),
  format text not null default 'xlsx' check (format in ('xlsx','csv','api')),
  row_count int not null,
  storage_path text,                     -- the generated file, if format <> 'api'
  file_hash_sha256 text,
  status text not null default 'generated'
    check (status in ('generated','delivered','acknowledged','failed')),
  delivered_at timestamptz,
  acknowledged_at timestamptz,           -- set when the module confirms it applied the change
  acknowledged_note text,
  generated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  error_message text
);
create index status_export_batch_generated_by_idx on public.status_export_batch (generated_by)
  where generated_by is not null;
create index status_export_batch_status_idx on public.status_export_batch (status);
