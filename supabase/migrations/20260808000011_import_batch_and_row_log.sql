create table public.import_batch (
  id bigint generated always as identity primary key,
  source_system text not null check (source_system in ('departmental','main')),
  source_filename text not null,
  file_hash_sha256 text not null,
  sheet_name text,
  mode text not null default 'dry_run' check (mode in ('dry_run','commit')),
  row_count int,
  imported_by uuid references auth.users(id),
  status text not null default 'processing'
    check (status in ('processing','completed','completed_with_exceptions','failed')),
  summary_jsonb jsonb,                   -- counts by action, for the preview screen
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text
);
create index import_batch_imported_by_idx on public.import_batch (imported_by)
  where imported_by is not null;

create table public.import_row_log (
  id bigint generated always as identity primary key,
  import_batch_id bigint not null references public.import_batch(id) on delete cascade,
  entry_id bigint,        -- FK to public.entries added in 20260808000014_entries_indexes.sql:
                           -- public.entries does not exist until 20260808000013, and this
                           -- file is ordered before it per §10's file list.
  row_number int not null,
  raw_row_jsonb jsonb not null,
  action text not null check (action in
    ('inserted','updated','unchanged','skipped_header','skipped_total',
     'skipped_no_ubbl','new_budget_head','new_vendor','error')),
  fields_changed jsonb,
  created_at timestamptz not null default now()
);
create index import_row_log_batch_idx on public.import_row_log (import_batch_id);
create index import_row_log_entry_idx on public.import_row_log (entry_id) where entry_id is not null;

-- Dry-run is the default (§3.6). Every import runs in `dry_run` first: it parses,
-- resolves, and writes import_row_log inside a transaction that is then rolled back,
-- leaving only the batch row and its summary. `import_row_log.raw_row_jsonb` is kept
-- 24 months per §4.4d -- bulky, useful for a season, not for years.
