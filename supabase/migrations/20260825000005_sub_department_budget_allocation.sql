-- Sub-department feature: its own periodic budget-import pipeline, mirroring
-- department_budget_allocation (20260822000001) exactly -- same append-only-
-- snapshot column list (id, <dimension>_id, import_batch_id, as_of, amount,
-- created_at, unique(<dimension>_id, import_batch_id)); current position =
-- latest row per sub-department, history comes free. Same RLS shape too:
-- select gated on private.is_staff(), update gated on
-- private.is_reviewer_or_admin(), no insert policy for `authenticated` at
-- all -- rows are written by the import pipeline running as service_role
-- (bypasses RLS entirely), never by an authenticated user directly.
--
-- Unlike department_budget_allocation (which predates the event system and
-- had event_id added nullable-then-backfilled by 20260822000005),
-- sub_department_budget_allocation is created after the event system
-- already exists, so event_id is not null from creation.
create table public.sub_department_budget_allocation (
  id bigint generated always as identity primary key,
  sub_department_id bigint not null references public.sub_department(id),
  event_id bigint not null references public.event(id),
  import_batch_id bigint not null references public.import_batch(id),
  as_of date not null,
  budget_amount numeric(14,2),
  created_at timestamptz not null default now(),
  unique (sub_department_id, import_batch_id)
);

-- (sub_department_id, as_of desc) -- matches
-- department_budget_allocation_dept_date_idx's pattern exactly: the latest-
-- per-sub-department lookup v_sub_department_budget_vs_actual runs
-- (distinct on (sub_department_id, event_id) order by as_of desc, id desc)
-- uses this index directly.
create index sub_department_budget_allocation_dept_date_idx
  on public.sub_department_budget_allocation (sub_department_id, as_of desc);

-- import_batch_id -- FK columns are not auto-indexed by Postgres; batch-
-- scoped lookups (e.g. "what did this import write") want it.
create index sub_department_budget_allocation_batch_idx
  on public.sub_department_budget_allocation (import_batch_id);

-- event_id -- same FK-indexing reasoning, and every event-scoped query site
-- filters by it from day one.
create index sub_department_budget_allocation_event_idx
  on public.sub_department_budget_allocation (event_id);

alter table public.sub_department_budget_allocation enable row level security;

create policy sub_department_budget_allocation_select
  on public.sub_department_budget_allocation for select to authenticated
  using ((select private.is_staff()));

create policy sub_department_budget_allocation_update_reviewer
  on public.sub_department_budget_allocation for update to authenticated
  using ((select private.is_reviewer_or_admin()))
  with check ((select private.is_reviewer_or_admin()));

-- No insert policy for `authenticated` -- see header comment. Deny-by-
-- default, same as department_budget_allocation/item_catalog/item_alias/
-- vendor_alias.

grant select, update on public.sub_department_budget_allocation to authenticated;

-- ----------------------------------------------------------------------------
-- import_batch.source_system -- widen the check constraint so the new
-- sub-department-budget importer (lib/import/run-sub-department-budget-
-- import.ts) can write its own batch rows into the same import_batch/
-- import_row_log tables, same reasoning department_budget_allocation's own
-- migration (20260822000001) documents for widening it from
-- ('departmental','audit') to add 'department_budget': drop and re-add with
-- the new value included, existing rows untouched.
-- ----------------------------------------------------------------------------
alter table public.import_batch drop constraint import_batch_source_system_check;
alter table public.import_batch add constraint import_batch_source_system_check
  check (source_system in ('departmental','audit','department_budget','sub_department_budget'));
