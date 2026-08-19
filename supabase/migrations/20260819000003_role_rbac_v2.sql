-- Three-tier role model: superadmin / admin / dept (confirmed 2026-08-19).
--
-- Renames the operational model from admin/reviewer/viewer to what the user
-- actually runs: `superadmin` (full access, incl. user management), `admin`
-- (every cross-department action EXCEPT user management), `dept` (create +
-- view entries in one or more assigned departments only -- verify/attach/
-- resolve/bulk-edit, everything `reviewer` used to additionally do, becomes
-- admin/superadmin-only rather than carrying over).
--
-- `staff_profile.department_id` (single, nullable, "null = all departments")
-- is retired in favour of `staff_department`, a junction table, because a
-- `dept` user may now be assigned MULTIPLE specific departments (never
-- "all" -- "all" is what makes you `admin`).
--
-- JUDGEMENT CALL on how the existing per-table policies get updated: rather
-- than touching every migration file that calls `private.is_admin()` or
-- `private.is_reviewer_or_admin()` (14 files beyond this one -- storage,
-- budget_category, item_catalog, scrape_token, audit logs, verify RPCs...),
-- this migration redefines those two functions' BODIES in place to mean
-- exactly what `private.is_admin_or_above()` means below. Every existing
-- policy that called `is_admin()` wanted "admin-or-above" all along under
-- the new model -- the ONLY place that ever needed the old top role
-- specifically is `staff_profile_update` (user management), which is
-- pinned to the new `private.is_superadmin()` explicitly, below. Likewise
-- every `is_reviewer_or_admin()` caller wanted "admin-or-above" under the
-- new model (dept drops every reviewer capability) except `entries_insert`,
-- which is repointed to `private.is_staff()` explicitly, below, since dept
-- keeps entry creation. This keeps the blast radius of this migration to
-- one file while every downstream policy gets the intended new behaviour
-- automatically. The names `is_admin()` / `is_reviewer_or_admin()` are kept
-- (not dropped) purely so the ~25 policies across other migration files
-- that reference them keep compiling -- read them as "is_admin_or_above()"
-- from this migration onward.

-- ============================================================================
-- 1. staff_department -- the junction table replacing department_id
-- ============================================================================
create table public.staff_department (
  staff_id uuid not null references public.staff_profile(id) on delete cascade,
  department_id bigint not null references public.department(id),
  primary key (staff_id, department_id)
);
-- every FK indexed (§3 preamble) -- staff_id is covered by the primary key already.
create index staff_department_department_id_idx on public.staff_department (department_id);

alter table public.staff_department enable row level security;
alter table public.staff_department force row level security;

create policy staff_department_select on public.staff_department for select to authenticated
  using (staff_id = (select auth.uid()) or (select private.is_admin_or_above()));

-- Assignment is a user-management action, same boundary as staff_profile_update:
-- superadmin only, so admin cannot promote itself into another department (or
-- another account into one) any more than it can promote a role.
create policy staff_department_insert on public.staff_department for insert to authenticated
  with check ((select private.is_superadmin()));
create policy staff_department_update on public.staff_department for update to authenticated
  using ((select private.is_superadmin()))
  with check ((select private.is_superadmin()));
create policy staff_department_delete on public.staff_department for delete to authenticated
  using ((select private.is_superadmin()));

-- JUDGEMENT CALL, noted inline like 20260808000026's own: that migration's blanket
-- `revoke delete ... from authenticated` only reaches tables that existed at the time
-- it ran, so it says nothing about this table either way. Unlike a financial row (voided,
-- never deleted), a department ASSIGNMENT is meant to be removable -- reassigning someone
-- away from a department should delete the row, not leave a dangling one -- so delete is
-- granted here explicitly rather than left unreachable by omission.
grant select, insert, update, delete on public.staff_department to authenticated;

-- ============================================================================
-- 2. Data migration -- in order, before anything is dropped
-- ============================================================================

-- 2a. Carry forward every scoped reviewer/viewer's single department into the
-- junction table before the role split below repurposes those rows.
insert into public.staff_department (staff_id, department_id)
select id, department_id from public.staff_profile
where role in ('reviewer', 'viewer') and department_id is not null
on conflict do nothing;

-- 2b. Old top role -> superadmin (this IS today's admin, unchanged capability).
update public.staff_profile set role = 'superadmin' where role = 'admin';

-- 2c. A scoped reviewer/viewer becomes dept (their one department is now in
-- staff_department from 2a).
update public.staff_profile
set role = 'dept'
where role in ('reviewer', 'viewer') and department_id is not null;

-- 2d. An all-departments reviewer/viewer (finance-head/auditor account, per
-- MASTER-PLAN §4.4c's old "viewer exists for the finance head and auditors")
-- would silently become full cross-department admin under the new model.
-- Land it as admin but deactivated, so a superadmin has to consciously
-- reactivate it rather than it gaining power nobody asked for.
update public.staff_profile
set role = 'admin', is_active = false
where role in ('reviewer', 'viewer') and department_id is null;

-- 2e. Only now can the check constraint and default change -- the values
-- above had to land under the OLD constraint first.
alter table public.staff_profile drop constraint staff_profile_role_check;
alter table public.staff_profile
  add constraint staff_profile_role_check check (role in ('superadmin', 'admin', 'dept'));
alter table public.staff_profile alter column role set default 'dept';

-- ============================================================================
-- 3. Helpers -- §4.1 replacements
-- ============================================================================

create or replace function private.is_superadmin() returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.staff_profile sp
                 where sp.id = (select auth.uid()) and sp.is_active and sp.role = 'superadmin');
$$;

create or replace function private.is_admin_or_above() returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.staff_profile sp
                 where sp.id = (select auth.uid()) and sp.is_active and sp.role in ('superadmin', 'admin'));
$$;

-- Rewritten to consult staff_department instead of the (about-to-be-dropped)
-- department_id column. Redefined BEFORE that column is dropped below so
-- there is never a moment where this function's body references it.
create or replace function private.can_see_department(dept_id bigint) returns boolean
language sql security definer stable set search_path = '' as $$
  select (select private.is_admin_or_above())
    or exists (
      select 1 from public.staff_profile sp
      join public.staff_department sd on sd.staff_id = sp.id
      where sp.id = (select auth.uid()) and sp.is_active and sd.department_id = dept_id
    );
$$;

-- Backward-compat aliases (see the JUDGEMENT CALL note at the top of this file):
-- every other migration's policies that call these two functions now get
-- admin-or-above semantics without having been touched individually.
create or replace function private.is_admin() returns boolean
language sql security definer stable set search_path = '' as $$
  select private.is_admin_or_above();
$$;

create or replace function private.is_reviewer_or_admin() returns boolean
language sql security definer stable set search_path = '' as $$
  select private.is_admin_or_above();
$$;

-- private.is_staff() is untouched -- any active row, role-agnostic -- and is
-- reused below as the entries-insert gate since all three roles create manual
-- entries in a department they can see.

-- ============================================================================
-- 4. Drop staff_profile.department_id -- fully superseded by staff_department
-- ============================================================================
alter table public.staff_profile drop constraint staff_profile_department_id_fkey;
drop index public.staff_profile_department_idx;
alter table public.staff_profile drop column department_id;

-- ============================================================================
-- 5. private.handle_new_user() -- department_id metadata -> department_ids array
-- ============================================================================
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_department_id bigint;
begin
  insert into public.staff_profile (
    id, display_name, role, is_active, its_number, contact_email
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    coalesce(new.raw_user_meta_data->>'role', 'dept'),
    coalesce((new.raw_user_meta_data->>'is_active')::boolean, false),
    new.raw_user_meta_data->>'its_number',
    new.raw_user_meta_data->>'contact_email'
  )
  on conflict (id) do nothing;

  if new.raw_user_meta_data ? 'department_ids' then
    for v_department_id in
      select value::bigint from jsonb_array_elements_text(new.raw_user_meta_data->'department_ids')
    loop
      insert into public.staff_department (staff_id, department_id)
      values (new.id, v_department_id)
      on conflict do nothing;
    end loop;
  end if;

  return new;
end; $$;

-- ============================================================================
-- 6. Policy updates -- the three that cannot be satisfied by the aliases above
-- ============================================================================

-- 6a. entries_insert (20260819000002): dept/admin/superadmin can all create,
-- scoped by can_see_department -- is_reviewer_or_admin() would now wrongly
-- exclude dept, so this one is pointed at is_staff() explicitly.
alter policy entries_insert on public.entries
  with check (
    (select private.is_staff())
    and department_id is not null
    and (select private.can_see_department(department_id))
    and source = 'manual'
  );

-- 6b. entries_update (20260808000026): dept loses UPDATE entirely under the
-- confirmed "view + create only" restriction -- this is what removes a dept
-- user's ability to self-complete the provisional-UBBL-number swap
-- (lib/actions/entries.ts replaceProvisionalUbblNumber); an admin/superadmin
-- has to do it for them from here on.
alter policy entries_update on public.entries
  using ((select private.can_see_department(department_id))
         and (select private.is_admin_or_above()))
  with check ((select private.can_see_department(department_id)));

-- 6c. staff_profile_update: the actual user-management boundary. Deliberately
-- NOT using the (now widened) is_admin() alias -- this is the one place that
-- must stay pinned to the true top role, or admin could edit its own row to
-- role = 'superadmin' and defeat the "cannot manage users" restriction.
--
-- Dropped and recreated (not ALTER POLICY) because private.staff_profile_
-- locked_fields (20260808000026) selects `sp.department_id`, which no longer
-- exists as of step 4 above -- it needs a new 2-column return signature
-- (role, is_active), and CREATE OR REPLACE FUNCTION cannot change an
-- existing function's return columns. This policy is its only caller
-- (verified: nothing else in the migrations references it), so it has to be
-- dropped first to clear the dependency, then the function can be dropped
-- and recreated, then the policy recreated against the new signature.
drop policy staff_profile_update on public.staff_profile;
drop function private.staff_profile_locked_fields(uuid);

create function private.staff_profile_locked_fields(p_id uuid)
returns table(role text, is_active boolean)
language sql security definer stable set search_path = '' as $$
  select sp.role, sp.is_active from public.staff_profile sp where sp.id = p_id;
$$;

create policy staff_profile_update on public.staff_profile for update to authenticated
  using (id = (select auth.uid()) or (select private.is_superadmin()))
  with check (
    (select private.is_superadmin())
    or (
      id = (select auth.uid())
      and (role, is_active) = (
        select role, is_active from private.staff_profile_locked_fields(id)
      )
    )
  );

-- staff_profile_select already reads correctly through the widened is_admin()
-- alias (admin can view the roster read-only, same as superadmin) -- no
-- change needed there.
