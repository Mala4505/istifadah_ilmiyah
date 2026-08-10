# Supabase DB Advisors Report

Ran `npx supabase db advisors --linked --type all --level info` against the linked
production project (`lkxdlnqviftoicjcbswz`, Istefadah_Ilmiyah) on 2026-08-10. Read-only
check — no `db push`, `db reset`, or migrations were run. Findings below are cross-checked
against `supabase/migrations/*.sql` (34 files, latest `20260811000004`).

## Summary

| Severity | Count | Genuine gap | Already addressed / expected |
|---|---|---|---|
| WARN (security) | 3 | 3 | 0 |
| INFO (security) | 2 | 2 (orphan tables) | 0 |
| INFO (performance) | 1 unindexed FK (genuine) + 2 (pre-existing, addressed by design) + ~25 unused-index | 1 | rest are noise/expected |
| INFO (auth config) | 1 | not actionable via migration | n/a |

None of the findings are ERROR level. Nothing here blocks Day 7 sign-off, but two items
are worth a follow-up migration by whichever agent owns schema cleanup next.

## Security findings

### WARN — `extension_in_public`: `pg_trgm` installed in public schema
**Genuine gap, not addressed.** `supabase/migrations/20260808000001_extensions.sql` runs
`create extension if not exists pg_trgm;` with no schema qualifier, so it lands in
`public`. Used for fuzzy vendor-name matching (`vendor.normalized_name`, migration
`20260808000008`). Standard Supabase advice is to move extensions to a dedicated
`extensions` schema. Low urgency (this is a lint-level convention, not an exploitable
hole), but a genuine gap against the codebase's own migrations.

### WARN — `anon_security_definer_function_executable` / `authenticated_security_definer_function_executable`: `public.rls_auto_enable()`
**Not from this codebase's migrations — a Supabase-platform-injected function.**
`grep` across all migration files finds no `rls_auto_enable` definition; querying
`pg_get_functiondef` shows it's an `event trigger` handler (`RETURNS event_trigger`,
`SECURITY DEFINER`) that auto-enables RLS on newly created `public` tables — a Supabase
project-level safety-net feature, not app code. It lives in `public` (the API-exposed
schema) with no explicit `REVOKE EXECUTE FROM anon, authenticated`, so the advisor
correctly flags it as callable via `/rest/v1/rpc/rls_auto_enable`. In practice calling it
via RPC does nothing harmful (it reads `pg_event_trigger_ddl_commands()`, which is only
populated inside an actual DDL event-trigger context, so a direct RPC call is a no-op/
error), but it's still worth a `revoke execute on function public.rls_auto_enable() from anon, authenticated;` migration to close the lint cleanly.

### WARN — `auth_leaked_password_protection`: disabled
**Not addressable via SQL migration** — this is a Supabase Auth project setting (HaveIBeenPwned
check on password set/change), not schema. No `supabase/config.toml` exists in this repo to
manage it declaratively either. Needs to be toggled in the Supabase dashboard (Auth →
Policies → Leaked password protection) or via the Management API — flagging as a decision
point for the user, not something I changed.

### INFO — `rls_enabled_no_policy`: `public.budget_head_category`, `public.budget_head_master`
**Genuine gap — orphan tables, not tracked by any migration.** Neither table is created by
any file in `supabase/migrations/`. The comment header in `20260811000002_budget_category.sql`
confirms `budget_category` was "renamed/simplified from the earlier budget_head_master
sketch" — these two appear to be leftovers from pre-migration prototyping directly on the
live DB, superseded by `budget_category` (migration `20260811000002`). Confirmed both are
**empty (0 rows)** via read-only query. RLS is enabled with no policies, so they're
inaccessible via the API as-is (fail-closed, not a live security hole), but they're schema
drift outside version control. Recommend a follow-up migration to `drop table` both, owned
by whichever agent touches the budget_head/budget_category area next — did not do this
myself per scope (avoiding collisions with the other four agents and unscoped live-DB
writes).

## Performance findings

### INFO — `unindexed_foreign_keys`: `entries.entries_audit_status_changed_by_fkey`
**Genuine gap.** `audit_status_changed_by` was added to `entries` in
`20260811000003_entries_restructure.sql` (`add column audit_status_changed_by uuid
references auth.users(id)`) without an accompanying index. By contrast, sibling `_by`
columns on the same table (`created_by`, `updated_by`, `hub_status_changed_by`) all have
covering indexes in `20260808000014_entries_indexes.sql`. Worth adding
`create index entries_audit_status_changed_by_idx on public.entries (audit_status_changed_by) where audit_status_changed_by is not null;`
in a follow-up migration, matching the existing partial-index convention.

### INFO — `unindexed_foreign_keys`: `budget_head_category_cluster_group_id_fkey`, `budget_head_master_category_id_fkey`
Same two orphan tables as above — not applicable once those tables are dropped.

### INFO — `unused_index` (~25 occurrences, e.g. `entries_date_idx`, `vendor_gstin_idx`, `job_queue_claim_idx`, etc.)
**Expected, not a gap.** This is a brand-new project (`created_at 2026-08-08`) with
effectively no production query traffic yet — Postgres's `pg_stat_user_indexes` usage
counters are near-zero for nearly every index in the schema, including ones that are
obviously load-bearing (e.g. `entries_status_idx`, `entries_hub_status_idx`). This is a
usage-driven advisor, not a design flaw; re-run after real usage accrues before acting on
any of these.

### INFO — `auth_db_connections_absolute`
Auth server is configured with an absolute (10) rather than percentage-based DB connection
allocation. Informational tuning note for scaling, not a Day-7 blocker.

## Recommendation

No action taken on the schema itself (out of scope per task instructions — avoiding
collisions with the other four agents and unscoped live-DB writes). Two items worth a
small follow-up migration: (1) drop the two empty orphan tables and their now-redundant
FK-index findings, (2) add the missing `audit_status_changed_by` index, and (3) optionally
revoke `rls_auto_enable` execute from `anon`/`authenticated`. `pg_trgm`-in-public and leaked
password protection are lower-priority/non-migration items to flag to the user.
