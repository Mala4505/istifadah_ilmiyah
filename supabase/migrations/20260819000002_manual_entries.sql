-- Manual entry creation for department-scoped staff (confirmed 2026-08-19).
--
-- Until now `entries` had NO insert policy at all: every row arrived through
-- the Departmental import or the Audit-portal scrape, both of which run as
-- `service_role` and bypass RLS by design (20260808000026's comment,
-- "INSERT: none -- importers run as service_role"). A department that types
-- its own bills instead of importing them had no way in.
--
-- Three things make that safe to open up:
--   1. the insert policy is department-scoped by the SAME helper the select
--      policy uses, so a scoped reviewer can only create rows in their own
--      department -- exactly the property that makes a departmental account
--      useful;
--   2. the policy's WITH CHECK pins `source = 'manual'`, so this path can
--      never be used to forge a row that later screens (and the operator
--      reading them) would read as import-owned;
--   3. `ubbl_number` gets a reserved, prefixed number from a sequence that
--      the import can never collide with -- see below.

-- ---- the reserved manual number range ---------------------------------------
-- Confirmed 2026-08-19: generate our own number, prefixed so it is obvious at a
-- glance that it is ours, and replace it with the real UBBL number once the
-- paperwork arrives. `ubbl_number` is `not null unique`, so a typed entry needs
-- SOME number immediately; a prefixed sequence value is the only kind that
-- cannot collide with a real UBBL number the import might bring in later.
--
-- The prefix is the whole contract: `M-` means "typed here, real number still
-- outstanding". `entries.source = 'manual'` records the row's origin
-- permanently; the `M-` prefix specifically records that the NUMBER is still
-- provisional, which is why it has to be visible in the number itself rather
-- than inferred from `source` -- once the real number replaces it, `source`
-- stays 'manual' but the provisional marker is gone, and that difference is
-- what a reviewer needs to see in a list.
create sequence public.manual_entry_number_seq;

-- Zero-padded so numbers sort lexically in the same order they were created --
-- every entries screen sorts ubbl_number as text.
create or replace function public.next_manual_ubbl_number() returns text
language sql volatile set search_path = '' as $$
  select 'M-' || lpad(nextval('public.manual_entry_number_seq')::text, 6, '0');
$$;

-- SECURITY INVOKER (the default): the sequence grant below is what authorises
-- the caller, so a non-staff account cannot burn numbers out of the range.
grant usage, select on sequence public.manual_entry_number_seq to authenticated;
grant execute on function public.next_manual_ubbl_number() to authenticated;

-- ---- insert policy ------------------------------------------------------------
-- Mirrors entries_update's shape (20260808000026): reviewer-or-admin, scoped to
-- a department the caller can see. `private.can_see_department` returns true for
-- an all-departments profile (department_id is null) and for the caller's own
-- department otherwise, so an admin can file against any department and a
-- department reviewer only against theirs.
--
-- `department_id is not null` is required here even though the column is
-- nullable: a null department on a typed row would be visible to (and editable
-- by) every department, which is precisely the leak this policy exists to
-- prevent. The import may still write null departments -- it bypasses RLS.
create policy entries_insert on public.entries for insert to authenticated
  with check (
    (select private.is_reviewer_or_admin())
    and department_id is not null
    and (select private.can_see_department(department_id))
    and source = 'manual'
  );

-- ---- audit stamping on insert ---------------------------------------------------
-- `private.log_entry_change` (20260808000017) is a BEFORE UPDATE trigger, so
-- until now nothing stamped created_by/updated_by on an INSERT -- there were no
-- client inserts to stamp. Same principle as that trigger: client-supplied audit
-- values are never trusted, so they are overwritten server-side rather than
-- validated. An import insert (service_role, no auth.uid()) leaves them null,
-- exactly as it does today.
create or replace function private.stamp_entry_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_at := now();
  new.updated_at := now();
  new.created_by := (select auth.uid());
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

create trigger entries_before_insert
  before insert on public.entries
  for each row execute function private.stamp_entry_insert();

-- ---- reporting -------------------------------------------------------------------
-- No view changes needed: v_entry_enriched already selects `source` and
-- `ubbl_number`, so a typed entry appears in every list, report and export the
-- moment it is created -- which is the confirmed behaviour ("live immediately",
-- 2026-08-19). Replacing the provisional number later is an ordinary UPDATE and
-- is already covered by entries_update + the change-log trigger, so the swap is
-- recorded in entry_change_log like any other edit.
