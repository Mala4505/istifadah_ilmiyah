-- Login brute-force lockout at the Supabase Auth layer (security audit M9,
-- owner decision D8; docs/security-audit-fix-plan.md 6.1).
--
-- Problem: the app's own limiter (lib/actions/auth.ts) only protects the
-- login *form*. Anyone can POST straight to
-- <SUPABASE_URL>/auth/v1/token?grant_type=password with the public key and the
-- synthetic email <ITS>@members.istifadah.internal, skipping it entirely.
--
-- Fix: Supabase Auth's "Password Verification Attempt" hook runs inside Auth on
-- EVERY password sign-in, however it arrives. This file only creates the
-- function and its table. The hook is switched on by hand in
-- Dashboard -> Authentication -> Hooks (docs/login-lockout-hook-setup.md).
-- NOTE: Supabase lists this hook as Team / Enterprise plans only.
--
-- Behaviour:
--   * 10 failed passwords for one account inside 15 minutes -> every further
--     attempt (even with the RIGHT password) is rejected until the window clears.
--   * Rejected-while-locked attempts are NOT recorded, so an attacker hammering
--     a locked account cannot extend the lock. It lasts at most 15 minutes
--     after the first of the 10 failures -- never permanent.
--   * A successful login clears that account's failure counter.
--   * Fail-open: if anything inside the hook errors, sign-in continues (a hook
--     bug must not become a company-wide outage; same stance as the app limiter).
--   * The hook only receives user_id, not the caller's IP, so the lock is
--     per-account. It is deliberately short for that reason (an attacker can
--     lock a known ITS for 15 min at a time, not indefinitely).
--
-- Why a new table instead of public.auth_login_attempt: that table is keyed by
-- its_number and the app limiter already writes a row there for every failed
-- form login. Sharing it would double-count each form attempt (the hook fires,
-- then the app records the same failure) and lock people out after ~5 mistakes.
-- This table is keyed by user_id and written only by the hook.

create table if not exists public.auth_hook_failed_attempt (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists auth_hook_failed_attempt_user_created_idx
  on public.auth_hook_failed_attempt (user_id, created_at desc);

-- RLS on with NO policies and no grants: nobody reaches this through
-- PostgREST. The hook function below is SECURITY DEFINER (runs as its owner,
-- which bypasses RLS), so supabase_auth_admin needs no table privileges at all
-- -- least privilege. (Supabase's own docs example grants the table to
-- supabase_auth_admin because their function is not security definer.)
alter table public.auth_hook_failed_attempt enable row level security;
revoke all on table public.auth_hook_failed_attempt from anon, authenticated, public;

create or replace function public.hook_password_verification_attempt(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id      uuid;
  v_valid        boolean;
  v_failures     integer;
  v_max_failures constant integer  := 10;
  v_window       constant interval := interval '15 minutes';
begin
  v_user_id := (event ->> 'user_id')::uuid;
  v_valid   := coalesce((event ->> 'valid')::boolean, false);

  if v_user_id is null then
    return jsonb_build_object('decision', 'continue');
  end if;

  -- Keep the table tiny: drop this account's rows that fell out of the window.
  delete from public.auth_hook_failed_attempt
   where user_id = v_user_id
     and created_at < now() - v_window;

  select count(*) into v_failures
    from public.auth_hook_failed_attempt
   where user_id = v_user_id
     and created_at >= now() - v_window;

  -- Locked: reject without recording, so hammering can't extend the lock.
  -- Checked before looking at `valid`, so a correct password is rejected too.
  if v_failures >= v_max_failures then
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'Too many attempts. Try again in 15 minutes.',
      'should_logout_user', false
    );
  end if;

  if v_valid then
    delete from public.auth_hook_failed_attempt where user_id = v_user_id;
  else
    insert into public.auth_hook_failed_attempt (user_id) values (v_user_id);
  end if;

  return jsonb_build_object('decision', 'continue');
exception
  when others then
    -- Fail open; surface in Postgres logs so it is not silent.
    raise warning 'hook_password_verification_attempt failed: % (%)', sqlerrm, sqlstate;
    return jsonb_build_object('decision', 'continue');
end;
$$;

-- Only Supabase Auth may call it. Functions default to EXECUTE for PUBLIC, so
-- revoke explicitly from every other role.
revoke execute on function public.hook_password_verification_attempt(jsonb)
  from authenticated, anon, public;
grant execute on function public.hook_password_verification_attempt(jsonb)
  to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;
