-- docs/pre-deploy-findings-and-plan.md §9 (Phase 9 -- Housekeeping and security), plus
-- docs/db-advisors-report.md which first raised all three items from a read-only
-- `npx supabase db advisors` run on 2026-08-10. No schema changes were made at that time
-- (out of scope for that pass, to avoid colliding with parallel agents and unscoped live-DB
-- writes) -- this migration is the deferred follow-up all three items called for.

-- ----------------------------------------------------------------------------
-- 1. Orphan tables budget_head_master / budget_head_category.
-- ----------------------------------------------------------------------------
-- Neither table is created by any file in supabase/migrations/ (confirmed by grep across
-- the whole directory) -- leftovers from pre-migration prototyping directly on the live
-- DB. The header of 20260811000002_budget_category.sql explains the real lineage:
-- budget_category (later renamed cost_center, 20260813000004) was "renamed/simplified
-- from the earlier budget_head_master sketch", and 20260822000005_event_scoping.sql's
-- header separately confirms budget_head_master "does not exist -- the real table is
-- `budget_head`". So these two are pure drift, not referenced by budget_category/
-- cost_center or budget_head, and no other tracked migration mentions either name.
-- db-advisors-report.md confirmed both empty (0 rows) via a read-only query on 2026-08-10
-- and RLS-enabled-with-no-policies (fail-closed, not a live security hole, but schema
-- drift outside version control). budget_head_master is dropped first: the advisors
-- report notes a `budget_head_master_category_id_fkey`, i.e. it is the referencing side
-- of a FK into budget_head_category, so it must go before its target.
drop table if exists public.budget_head_master;
drop table if exists public.budget_head_category;

-- ----------------------------------------------------------------------------
-- 2. Missing index on entries.audit_status_changed_by.
-- ----------------------------------------------------------------------------
-- audit_status_changed_by was added to entries in 20260811000003_entries_restructure.sql
-- with no covering index. Every sibling `_by` column on the same table has one, all as
-- partial indexes over the non-null rows, all named `entries_<column>_idx`:
--   entries_hub_status_changed_by_idx  on entries (hub_status_changed_by)  where ... is not null
--   (20260808000014_entries_indexes.sql)
-- Matching that exact naming and partial-index convention.
create index if not exists entries_audit_status_changed_by_idx
  on public.entries (audit_status_changed_by)
  where audit_status_changed_by is not null;

-- ----------------------------------------------------------------------------
-- 3. rls_auto_enable() executable by anon/authenticated.
-- ----------------------------------------------------------------------------
-- Not defined in any migration in this codebase -- grep across supabase/migrations/ finds
-- no `rls_auto_enable` -- it is a Supabase-platform-injected event-trigger handler
-- (confirmed live via pg_get_functiondef on 2026-08-10, recorded in
-- docs/db-advisors-report.md: RETURNS event_trigger, SECURITY DEFINER, no parameters --
-- event trigger functions never take arguments). It lives in `public`, the API-exposed
-- schema, with no explicit revoke, so PostgREST exposes it at
-- /rest/v1/rpc/rls_auto_enable. Calling it that way is a functional no-op (it reads
-- pg_event_trigger_ddl_commands(), which is only populated inside an actual DDL
-- event-trigger context), but it's still worth closing the advisor's
-- anon_security_definer_function_executable / authenticated_security_definer_function_executable
-- lint. The signature is the bare no-arg form -- an event trigger function cannot be
-- declared any other way.
revoke execute on function public.rls_auto_enable() from anon, authenticated;
