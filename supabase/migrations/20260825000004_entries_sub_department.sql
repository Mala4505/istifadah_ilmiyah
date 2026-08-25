-- Sub-department feature: the classification column on entries. Mirrors
-- entries_zone_idx (20260808000014_entries_indexes.sql:5) exactly -- a
-- nullable FK plus a partial index (most entries won't have one set until
-- reviewers work through Stage 3 classification going forward).
alter table public.entries add column sub_department_id bigint references public.sub_department(id);
create index entries_sub_department_idx on public.entries (sub_department_id)
  where sub_department_id is not null;
