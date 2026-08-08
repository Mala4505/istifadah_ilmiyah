create table public.entry_status (
  id bigint generated always as identity primary key,
  code text not null unique,
  label text not null,
  source_system text not null check (source_system in ('departmental','main')),
  sort_order int not null,
  is_terminal boolean not null default false
);
-- Do NOT seed this from guesswork (§3.3). The real Departmental/Main export only ever
-- contains 'pending', 'sent_main' (departmental) and 'approved' (main) -- see seed.sql.
-- The importer auto-inserts any unseen status code with sort_order = 999 and raises a
-- low-severity exception, so an unknown status surfaces instead of silently mapping to
-- null. The raw text is preserved on the entry regardless (entries.tenant_status_raw /
-- main_status_raw).
