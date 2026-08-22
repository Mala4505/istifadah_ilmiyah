-- Review-page-redesign plan §11 (2026-08-22) -- department-level budget vs
-- actual. A separate, department-grained sibling of budget_head/
-- budget_allocation/v_budget_vs_actual (20260808000007/16, 20260811000004):
-- that system scores the ~42 granular expense-category rows per department,
-- fed by the regular entries Excel import's own budget-head dimension. This
-- table is a DIFFERENT set of figures -- department-level totals the user
-- will hand over as a standalone Excel sheet (department name, budget
-- amount) -- not a rollup of the per-head allocations. See the plan doc for
-- the full spec; this migration builds §11's table only, no real import has
-- run yet.
--
-- Shape and RLS deliberately mirror two existing precedents:
--   - public.budget_allocation (20260808000016): same append-only-snapshot
--     column list (id, <dimension>_id, import_batch_id, as_of, amount,
--     created_at, unique(<dimension>_id, import_batch_id)), same reasoning --
--     current position = latest row per department; history comes free.
--   - public.item_catalog / item_alias (20260814000001:149-174): same RLS
--     shape -- select gated on private.is_staff(), update gated on
--     private.is_reviewer_or_admin() (both using + with check), NO insert
--     policy for `authenticated` at all. Rows are written by the import
--     pipeline running as service_role (bypasses RLS entirely), never by an
--     authenticated user directly -- deny-by-default for inserts is
--     deliberate, not an oversight.
create table public.department_budget_allocation (
  id bigint generated always as identity primary key,
  department_id bigint not null references public.department(id),
  import_batch_id bigint not null references public.import_batch(id),
  as_of date not null,
  budget_amount numeric(14,2),
  created_at timestamptz not null default now(),
  unique (department_id, import_batch_id)
);

-- (department_id, as_of desc) -- matches budget_allocation_head_date_idx's
-- pattern exactly: the latest-per-department lookup v_department_budget_vs_actual
-- runs (distinct on (department_id) order by as_of desc, id desc) uses this
-- index directly.
create index department_budget_allocation_dept_date_idx
  on public.department_budget_allocation (department_id, as_of desc);

-- import_batch_id -- FK columns are not auto-indexed by Postgres (schema-
-- foreign-key-indexes best practice) and budget_allocation carries the same
-- index on its own import_batch_id for the same reason: batch-scoped lookups
-- (e.g. "what did this import write") and the FK's implicit lookup on any
-- future update/delete of import_batch both want it.
create index department_budget_allocation_batch_idx
  on public.department_budget_allocation (import_batch_id);

alter table public.department_budget_allocation enable row level security;

create policy department_budget_allocation_select
  on public.department_budget_allocation for select to authenticated
  using ((select private.is_staff()));

create policy department_budget_allocation_update_reviewer
  on public.department_budget_allocation for update to authenticated
  using ((select private.is_reviewer_or_admin()))
  with check ((select private.is_reviewer_or_admin()));

-- No insert policy for `authenticated` -- see header comment. Deny-by-default,
-- same as item_catalog/item_alias/vendor_alias.

grant select, update on public.department_budget_allocation to authenticated;

-- ----------------------------------------------------------------------------
-- import_batch.source_system -- widen the check constraint so the new
-- department-budget importer (lib/import/run-department-budget-import.ts) can
-- write its own batch rows into the SAME import_batch/import_row_log tables
-- (one batch row per run, one row-log row per source row -- §11's own
-- instruction to reuse the existing conventions rather than build parallel
-- bookkeeping tables). Widened the same way 20260811000003 widened it from
-- ('departmental','main') to ('departmental','audit'): drop and re-add with
-- the new value included, existing rows untouched.
-- ----------------------------------------------------------------------------
alter table public.import_batch drop constraint import_batch_source_system_check;
alter table public.import_batch add constraint import_batch_source_system_check
  check (source_system in ('departmental','audit','department_budget'));
