-- budget_category (confirmed 2026-08-11, MASTER-PLAN §3.1, renamed/simplified from the
-- earlier budget_head_master sketch). A flat, curated, cross-department category list --
-- the bracket half of labels like "Dummas (AVIT)" in Departmental/budget heads.1.xlsx.
-- Not scoped to a department: the same category (e.g. "AVIT") repeats across several.
-- Explicitly NOT the same table as admin_head or budget_head, and has no FK to either --
-- see §3.1 for why this got conflated mid-conversation and the explicit correction.
create table public.budget_category (
  id bigint generated always as identity primary key,
  name text not null,
  cluster_group_id bigint references public.budget_category(id),  -- self-ref merge,
                                          -- same pattern as vendor.cluster_group_id --
                                          -- for near-duplicate spellings, null = independent
  is_confirmed boolean not null default false,
  created_at timestamptz not null default now()
);
create index budget_category_cluster_idx on public.budget_category (cluster_group_id)
  where cluster_group_id is not null;

alter table public.budget_category enable row level security;
alter table public.budget_category force row level security;

-- Same shape as vendor's policies (20260808000026): staff-wide read, admin-only write.
-- Unlike vendor (created only by the import pipeline's service-role client), rows here
-- are expected to be added by an admin from the org's own master file via an admin
-- screen -- an authenticated insert policy, not just an update one.
create policy budget_category_select on public.budget_category for select to authenticated
  using ((select private.is_staff()));
create policy budget_category_insert_admin on public.budget_category for insert to authenticated
  with check ((select private.is_admin()));
create policy budget_category_update_admin on public.budget_category for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

-- Postdates 20260808000026's blanket grant, same reasoning as every table added since
-- (20260810000002/3, this one too).
grant select, insert, update on public.budget_category to authenticated;
grant usage, select on sequence public.budget_category_id_seq to authenticated;
