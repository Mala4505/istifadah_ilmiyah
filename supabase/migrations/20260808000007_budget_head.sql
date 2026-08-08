-- The source system's OWN budget-head dimension. Auto-created on import.
-- head_id stays null until you decide to merge the two dimensions.
create table public.budget_head (
  id bigint generated always as identity primary key,
  department_id bigint references public.department(id),
  raw_label text not null unique,        -- 'Venue setup (AVIT)' exactly as exported
  short_label text,                      -- 'AVIT' — parsed from the parentheses
  head_id bigint references public.head(id),   -- the future merge point; null for now
  first_seen_batch_id bigint,            -- intentionally NOT a FK: public.import_batch is
                                          -- created later (20260808000011); adding one here
                                          -- would be a forward reference. Left as a plain
                                          -- id, exactly per the master plan's §3.1 example.
  created_at timestamptz not null default now()
);
create index budget_head_head_idx on public.budget_head (head_id);
create index budget_head_department_idx on public.budget_head (department_id)
  where department_id is not null;
