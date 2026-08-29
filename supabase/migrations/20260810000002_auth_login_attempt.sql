-- Defense-in-depth login rate limiting, on top of (not instead of) Supabase
-- Auth's own built-in brute-force protection on signInWithPassword. This
-- table is app-owned so its thresholds are tunable in code/SQL rather than
-- only via the hosted project's dashboard, and it doubles as an audit trail
-- of who attempted to log in, from where, and whether it succeeded.
--
-- Insert-only, written exclusively by lib/actions/auth.ts's loginWithIts
-- through the service-role admin client (a login attempt happens before
-- there is any session to write through RLS with, including failed ones).
create table public.auth_login_attempt (
  id bigint generated always as identity primary key,
  its_number text not null,
  ip inet,
  success boolean not null,
  created_at timestamptz not null default now()
);

-- Both lockout-window checks in lib/actions/auth.ts (failed attempts per ITS
-- number, and failures across many DISTINCT ITS numbers per IP, within
-- 15 minutes — see that file for the current thresholds and the reasoning
-- for a distinct-account per-IP rule) scan by (key, created_at) — indexed
-- accordingly. The check runs as two plain PostgREST reads through the admin
-- client rather than a
-- database function: `private` is deliberately never in `pgrst.db_schemas`
-- (20260808000002), so a `private.*` function is not reachable via
-- supabase-js's `.rpc()` at all, and a `public` one would need its own
-- grant/revoke story to avoid being callable by anon/authenticated. Two
-- counts is simple enough not to need either.
create index auth_login_attempt_its_number_idx on public.auth_login_attempt (its_number, created_at desc);
create index auth_login_attempt_ip_idx on public.auth_login_attempt (ip, created_at desc)
  where ip is not null;

alter table public.auth_login_attempt enable row level security;
alter table public.auth_login_attempt force row level security;

-- Audit visibility only — an admin reviewing suspicious activity. No write
-- policy for authenticated at all: every row is written by the service-role
-- client, which bypasses RLS by design (§4.5).
create policy auth_login_attempt_select_admin on public.auth_login_attempt for select to authenticated
  using ((select private.is_admin()));

-- This table postdates 20260808000026_rls_policies.sql's blanket
-- `grant select, insert, update on all tables in schema public to authenticated`,
-- so it needs its own grant or PostgREST returns "permission denied" for every
-- query regardless of the RLS policy above (same reasoning as
-- 20260808000028's per-view grant). insert/update stay ungranted: every write
-- goes through the service-role admin client only.
grant select on public.auth_login_attempt to authenticated;
