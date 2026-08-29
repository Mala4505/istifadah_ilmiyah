-- Document assignment -- "dividing the document inbox" (feature plan 2026-08-29).
--
-- Today an unmatched PDF is visible to every active staff member and the only
-- ownership signal is the 15-minute `claimed_by` lock on /review -- a soft,
-- racy, expiring hold, not a division of labour. This migration adds a durable
-- ownership layer INSIDE the admin tier: a document can be assigned to one or
-- more admins at upload (or in the inbox), and visibility then follows the
-- assignment.
--
-- Grain: the DOCUMENT, mirroring `source_document.claimed_by`. A multi-bill PDF
-- is assigned as a unit. Assignment is a set (0..n admins), so it is a junction
-- table rather than a column -- no rows = the shared "pool".
--
-- Decisions baked in here (from the plan's open-questions section):
--   * The pool is visible to ALL admins (self-assign is the normal path); it is
--     not superadmin-only.
--   * `dept` is unchanged: a dept user sees an UNASSIGNED document exactly as
--     today (unmatched, or matched into a department they can see). Once a
--     document has assignees it is scoped to those assignees + superadmin, and
--     leaves every other view -- which is the whole point of "no overtaking".
--   * History is `assigned_by` / `assigned_at` on the current rows. No separate
--     event table until a per-person audit report is actually asked for.

-- ============================================================================
-- 1. source_document_assignee -- the junction table
-- ============================================================================
create table public.source_document_assignee (
  source_document_id bigint not null references public.source_document(id) on delete cascade,
  staff_id           uuid   not null references public.staff_profile(id) on delete cascade,
  assigned_by        uuid   references public.staff_profile(id) on delete set null,
  assigned_at        timestamptz not null default now(),
  primary key (source_document_id, staff_id)
);

-- Every FK indexed (repo convention, §3 preamble of 20260808000026):
-- source_document_id is covered by the primary key's leading column already.
create index source_document_assignee_staff_id_idx on public.source_document_assignee (staff_id);
create index source_document_assignee_assigned_by_idx on public.source_document_assignee (assigned_by)
  where assigned_by is not null;

alter table public.source_document_assignee enable row level security;
alter table public.source_document_assignee force row level security;

-- Read: your own assignment rows, or admin-or-above (to render the assignee
-- column in the inbox and the superadmin workload board). `dept` never needs
-- this table -- it only ever sees documents that have no assignee rows at all.
create policy source_document_assignee_select on public.source_document_assignee
  for select to authenticated
  using (staff_id = (select auth.uid()) or (select private.is_admin_or_above()));

-- No insert/update/delete policy for `authenticated`: every write goes through
-- private.set_source_document_assignees (SECURITY DEFINER) below, the single
-- gated entry point -- same posture as delete_source_document (20260820000001).
-- A stray `.insert()` / `.delete()` from application code fails with permission
-- denied, by design.
grant select on public.source_document_assignee to authenticated;
revoke insert, update, delete on public.source_document_assignee from authenticated;

-- ============================================================================
-- 2. can_see_source_document -- rewritten to consult the assignee table
-- ============================================================================
-- This one helper gates source_document_select and, transitively,
-- document_page / ocr_extraction_run / document_extraction /
-- document_extraction_line_item (all of which call it via
-- private.can_see_document_extraction or directly -- 20260808000026), plus the
-- security_invoker views v_review_queue / v_review_queue_all. So the review
-- queue filters itself per-person with no change to any of those objects.
--
-- Precedence:
--   superadmin                                  -> every document
--   you are one of the document's assignees     -> that document
--   the document has NO assignees (the "pool")  -> fall back to the pre-existing
--       rule: admin-or-above sees all; any other active staff (i.e. `dept`)
--       sees it when it is unmatched or matched into a department they can see.
create or replace function private.can_see_source_document(p_source_document_id bigint) returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (
    select 1
    from public.source_document sd
    left join public.entries e on e.id = sd.entry_id
    where sd.id = p_source_document_id
      and (
        (select private.is_superadmin())
        or exists (
          select 1 from public.source_document_assignee sda
          where sda.source_document_id = sd.id
            and sda.staff_id = (select auth.uid())
        )
        or (
          not exists (
            select 1 from public.source_document_assignee sda
            where sda.source_document_id = sd.id
          )
          and (
            (select private.is_admin_or_above())
            or (
              (select private.is_staff())
              and (sd.entry_id is null or (select private.can_see_department(e.department_id)))
            )
          )
        )
      )
  );
$$;

-- ============================================================================
-- 3. set_source_document_assignees -- the single write path
-- ============================================================================
-- Replaces the assignee set for each of `p_ids` with `p_staff_ids` (empty /
-- null array = send back to the pool). Enforces, in the same transaction as
-- the write:
--   * caller is admin-or-above;
--   * every target id is an ACTIVE admin or superadmin (never a `dept` user,
--     never a deactivated account);
--   * anti-overtaking -- a non-superadmin may only touch a document that is
--     unassigned or already includes them, and may not drop another admin who
--     is currently on it. A superadmin may do anything.
-- A document that fails a per-row check is returned in `refused_ids` rather
-- than aborting the batch -- the partial-success shape lib/actions already use.
--
-- Side effect: a `claimed_by` lock held by someone who ends up NOT on the
-- document is cleared, so a reassignment doesn't leave the new owner blocked
-- by a stale 15-minute hold (companion to 20260828000004).
create or replace function private.set_source_document_assignees(
  p_ids bigint[],
  p_staff_ids uuid[]
) returns table (updated_count int, refused_ids bigint[])
language plpgsql security definer set search_path = '' as $$
declare
  v_actor    uuid := (select auth.uid());
  v_is_super boolean := (select private.is_superadmin());
  v_staff    uuid[];
  v_id       bigint;
  v_updated  int := 0;
  v_refused  bigint[] := '{}'::bigint[];
begin
  if not (select private.is_admin_or_above()) then
    raise exception 'Assigning documents requires the admin role.';
  end if;

  -- de-dupe the incoming set
  select coalesce(array_agg(distinct s), '{}'::uuid[])
    into v_staff
  from unnest(coalesce(p_staff_ids, '{}'::uuid[])) as s;

  if exists (
    select 1 from unnest(v_staff) as s
    where not exists (
      select 1 from public.staff_profile sp
      where sp.id = s and sp.is_active and sp.role in ('admin', 'superadmin')
    )
  ) then
    raise exception 'Documents can only be assigned to active admins.';
  end if;

  foreach v_id in array coalesce(p_ids, '{}'::bigint[])
  loop
    if not (select private.can_see_source_document(v_id)) then
      v_refused := v_refused || v_id;
      continue;
    end if;

    if not v_is_super then
      -- unassigned, or already includes me?
      if exists (select 1 from public.source_document_assignee sda where sda.source_document_id = v_id)
         and not exists (
           select 1 from public.source_document_assignee sda
           where sda.source_document_id = v_id and sda.staff_id = v_actor
         )
      then
        v_refused := v_refused || v_id;
        continue;
      end if;
      -- not dropping another admin who is currently on it?
      if exists (
        select 1 from public.source_document_assignee sda
        where sda.source_document_id = v_id
          and sda.staff_id <> v_actor
          and sda.staff_id <> all (v_staff)
      ) then
        v_refused := v_refused || v_id;
        continue;
      end if;
    end if;

    delete from public.source_document_assignee where source_document_id = v_id;
    if array_length(v_staff, 1) is not null then
      insert into public.source_document_assignee (source_document_id, staff_id, assigned_by, assigned_at)
      select v_id, s, v_actor, now() from unnest(v_staff) as s;
    end if;

    update public.source_document sd
       set claimed_by = null, claimed_at = null
     where sd.id = v_id
       and sd.claimed_by is not null
       and sd.claimed_by <> all (v_staff);

    v_updated := v_updated + 1;
  end loop;

  return query select v_updated, v_refused;
end;
$$;

comment on function private.set_source_document_assignees(bigint[], uuid[]) is
  'Replace the assignee set for each document id. Empty/null staff array = back to the pool. Enforces admin gate, active-admin-only targets, and the anti-overtaking rule (non-superadmin: only unassigned-or-own documents, cannot drop another admin). Per-row failures land in refused_ids rather than aborting. Clears a stale claimed_by held by someone no longer assigned. Feature: document assignment, 2026-08-29.';

-- Thin PostgREST-callable wrapper (same private-logic / public-wrapper split as
-- verify_document_extraction).
create or replace function public.set_source_document_assignees(
  p_ids bigint[],
  p_staff_ids uuid[]
) returns table (updated_count int, refused_ids bigint[])
language sql security definer set search_path = '' as $$
  select * from private.set_source_document_assignees(p_ids, p_staff_ids);
$$;

grant execute on function public.set_source_document_assignees(bigint[], uuid[]) to authenticated;

-- ============================================================================
-- 4. Backfill -- deliberately nothing
-- ============================================================================
-- No existing document has assignee rows, so every one of them is in the pool
-- and stays visible to all admins exactly as before this migration ran. The
-- feature is opt-in from the first upload after it ships.
