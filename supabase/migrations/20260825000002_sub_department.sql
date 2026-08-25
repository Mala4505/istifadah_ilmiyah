-- Sub-department feature (docs/hashed-prancing-gem plan): a third
-- independent, parallel classification alongside admin_head/zone -- each
-- sub-department belongs to exactly one department, scoped the same way
-- zone is (public.zone, 20260808000006). Seeded/read-only master data (no
-- admin CRUD screen), curated from a spreadsheet the user will hand over.
--
-- Mirrors zone's shape, minus zone's zone_number column -- the sub-
-- department spreadsheet's shape isn't known yet, so no
-- sub_department_number column for now (sort by name everywhere); adding a
-- number column later is a cheap additive migration once the real sheet is
-- seen.
--
-- Unlike zone (whose RLS was added later, in 20260808000026_rls_policies.sql),
-- RLS goes inline here -- matching the more recent
-- department_budget_allocation convention (20260822000001).
create table public.sub_department (
  id bigint generated always as identity primary key,
  department_id bigint not null references public.department(id),
  name text not null,
  is_active boolean not null default true,
  unique (department_id, name)
);
create index sub_department_department_idx on public.sub_department (department_id);

alter table public.sub_department enable row level security;
alter table public.sub_department force row level security;

-- Same shape as zone_select (20260808000026:123-124): staff-only, scoped to
-- departments the caller can see.
create policy sub_department_select on public.sub_department for select to authenticated
  using ((select private.is_staff()) and (select private.can_see_department(department_id)));

-- No insert/update/delete policy for `authenticated` -- read-only master
-- data, same as admin_head/zone/department. Deny-by-default is deliberate.

grant select on public.sub_department to authenticated;
