-- Security audit 2026-10-15, Phase 2: medium-severity RLS hardening.
-- Plan: docs/security-audit-fix-plan.md (Phase 2, tasks 2.1-2.6; owner decisions D3, D4, D5).
--
--   2.1 (M2)  closed events are read-only in the database (superadmin may still edit).
--   2.2 (M3)  only a superadmin can delete a VERIFIED extraction.
--   2.3 (M4)  reconciliation_exception + flags: no delete, no forged resolver, department scope.
--   2.4 (M11) board pack (table + storage bucket) is admin-or-above only.
--   2.5 (D4)  import logs / status exports are admin-or-above only.
--   2.6 (L17) a user cannot rewrite their own its_number / contact_email.
--
-- Idempotent: create or replace for functions, alter policy / drop policy if exists +
-- create for policies, drop trigger if exists + create for triggers.
-- Final pre-existing definitions each statement is based on are named in its comment.
-- Style notes (from 20261005120000): uncorrelated `(select fn())` calls become InitPlans;
-- array comparisons use `= any ((select fn())::bigint[])` -- the cast is required, a bare
-- `= any ((select fn()))` parses as ANY(subquery).

-- ============================================================================
-- 0. Helpers
-- ============================================================================

-- True when the caller may write to rows of event `eid`: superadmin always, everyone
-- else only while the event is the current one (D5). Unknown/null event => false for
-- non-superadmin.
create or replace function private.event_writable(eid bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select private.is_superadmin())
      or coalesce((select e.is_current from public.event e where e.id = eid), false)
$$;

-- Same, resolved through a source_document / a document_extraction (bill).
create or replace function private.source_document_event_writable(p_source_document_id bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select private.event_writable(
    (select sd.event_id from public.source_document sd where sd.id = p_source_document_id)))
$$;

create or replace function private.extraction_event_writable(p_document_extraction_id bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select private.event_writable(
    (select sd.event_id
       from public.document_extraction de
       join public.source_document sd on sd.id = de.source_document_id
      where de.id = p_document_extraction_id)))
$$;

-- Write gate shared by reconciliation_exception and flags (insert / update).
-- Every target the row points at must be visible to the caller (the same helpers the
-- document / entry policies use), and -- unless the caller is a superadmin -- none of
-- the events those targets belong to may be closed. A row with no target at all
-- (e.g. an allocation-sum exception) is allowed; the policies still require the
-- reviewer-or-admin role.
create or replace function private.exception_target_writable(
  p_entry_id bigint,
  p_document_extraction_id bigint,
  p_source_document_id bigint,
  p_import_batch_id bigint
) returns boolean
language sql stable security definer set search_path = '' as $$
  select
    (p_entry_id is null or (select private.can_see_entry(p_entry_id)))
    and (p_document_extraction_id is null or (select private.can_see_document_extraction(p_document_extraction_id)))
    and (p_source_document_id is null or (select private.can_see_source_document(p_source_document_id)))
    and (
      (select private.is_superadmin())
      or not exists (
        select 1 from public.event ev
         where not ev.is_current
           and ev.id in (
             (select en.event_id from public.entries en where en.id = p_entry_id),
             (select sd.event_id
                from public.document_extraction de
                join public.source_document sd on sd.id = de.source_document_id
               where de.id = p_document_extraction_id),
             (select sd2.event_id from public.source_document sd2 where sd2.id = p_source_document_id),
             (select ib.event_id from public.import_batch ib where ib.id = p_import_batch_id)
           )
      )
    )
$$;

revoke all on function private.event_writable(bigint)                              from public, anon;
revoke all on function private.source_document_event_writable(bigint)              from public, anon;
revoke all on function private.extraction_event_writable(bigint)                    from public, anon;
revoke all on function private.exception_target_writable(bigint, bigint, bigint, bigint) from public, anon;
grant execute on function private.event_writable(bigint)                              to authenticated;
grant execute on function private.source_document_event_writable(bigint)              to authenticated;
grant execute on function private.extraction_event_writable(bigint)                    to authenticated;
grant execute on function private.exception_target_writable(bigint, bigint, bigint, bigint) to authenticated;

-- ============================================================================
-- 2.1 (M2) Closed events are read-only in the DB (D5: superadmin may still edit)
-- ============================================================================

-- entries_insert: final definition 20261005120000 section 2, plus the event predicate.
-- Uses the same InitPlan-friendly form as the rest of that migration: the current event
-- id is one uncorrelated scalar subquery (event_one_current guarantees at most one row);
-- no current event => null => comparison is not true => insert denied for non-superadmin.
alter policy entries_insert on public.entries
  with check (
    (select private.is_staff())
    and department_id is not null
    and (
      (select private.is_admin_or_above())
      or department_id = any ((select private.my_department_ids())::bigint[])
    )
    and source = 'manual'
    and (
      (select private.is_superadmin())
      or event_id = (select ev.id from public.event ev where ev.is_current)
    )
  );

-- entries_update: final definition 20261005120000 section 2, plus the event predicate on
-- both the old row (using) and the new row (with check), so an entry cannot be moved
-- into or out of a closed event by a non-superadmin either.
alter policy entries_update on public.entries
  using (
    (
      (select private.is_admin_or_above())
      or department_id = any ((select private.my_department_ids())::bigint[])
    )
    and (select private.is_admin_or_above())
    and (
      (select private.is_superadmin())
      or event_id = (select ev.id from public.event ev where ev.is_current)
    )
  )
  with check (
    (
      (select private.is_admin_or_above())
      or department_id = any ((select private.my_department_ids())::bigint[])
    )
    and (
      (select private.is_superadmin())
      or event_id = (select ev.id from public.event ev where ev.is_current)
    )
  );
-- There is no entries delete policy (financial rows are voided, never deleted), so
-- nothing to add there.

-- verify_document_extraction: the public wrapper (final: 20260821000007 section "wrapper")
-- is the only entry point reachable by `authenticated`; the private body
-- (final: 20261005075123) is untouched. The wrapper is now plpgsql so it can refuse a
-- bill whose event is closed (unless superadmin) BEFORE delegating. A bill that does not
-- exist falls through so the private function keeps raising its own "No document_extraction
-- row exists" error. Signature, return columns and grants are unchanged.
create or replace function public.verify_document_extraction(
  p_document_extraction_id bigint,
  p_header jsonb,
  p_line_items jsonb,
  p_vendor_id bigint default null,
  p_expected_extraction_run_id bigint default null
) returns table (
  document_extraction_id bigint,
  line_items_updated int,
  rate_reference_rows_inserted int
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.document_extraction de where de.id = p_document_extraction_id)
     and not (select private.extraction_event_writable(p_document_extraction_id)) then
    raise exception 'This bill belongs to a closed event; only a superadmin can change it.'
      using errcode = '42501';
  end if;

  return query
  select * from private.verify_document_extraction(
    p_document_extraction_id, p_header, p_line_items, p_vendor_id, p_expected_extraction_run_id
  );
end;
$$;

-- The link RPCs (set_bill_entry_links, add_bill_entry_link, remove_bill_entry_link,
-- set_document_entry_links, remove_entry_bill_links) already funnel through
-- private.assert_entry_bill_link_allowed (20260908000001), which refuses any document
-- whose event is not current. That is stricter than D5 (superadmin is refused too), so it
-- is intentionally left alone here.

-- clear_bill_rate_reference_links: final definition 20260914000002, plus (a) the closed
-- event guard and (b) the verified-bill guard from 2.2 -- the skip-page flow calls this just
-- before deleting the bill, and without the guard it would let an admin detach rate history
-- from a verified bill in a closed event.
create or replace function public.clear_bill_rate_reference_links(
  p_document_extraction_id bigint
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_sd bigint;
  v_verified_at timestamptz;
begin
  select de.source_document_id, de.verified_at into v_sd, v_verified_at
  from public.document_extraction de
  where de.id = p_document_extraction_id;

  if v_sd is null then
    raise exception 'Bill % not found.', p_document_extraction_id;
  end if;

  if not (select private.is_reviewer_or_admin()) then
    raise exception 'Clearing rate history requires the reviewer or admin role.';
  end if;

  if not (select private.can_see_source_document(v_sd)) then
    raise exception 'You do not have access to document %.', v_sd;
  end if;

  if not (select private.source_document_event_writable(v_sd)) then
    raise exception 'This bill belongs to a closed event; only a superadmin can change it.'
      using errcode = '42501';
  end if;

  if v_verified_at is not null and not (select private.is_superadmin()) then
    raise exception 'This bill is already verified; only a superadmin can change its rate history.'
      using errcode = '42501';
  end if;

  update public.rate_reference rr
  set line_item_id = null
  where rr.line_item_id in (
    select li.id
    from public.document_extraction_line_item li
    where li.document_extraction_id = p_document_extraction_id
  );
end;
$$;

-- document_extraction_update: final 20261005120000 (using) / 20260808000026 (with check),
-- plus the event predicate.
alter policy document_extraction_update on public.document_extraction
  using (
    (select private.is_reviewer_or_admin())
    and (
      (select private.is_superadmin())
      or source_document_id = any ((select private.visible_source_document_ids())::bigint[])
    )
    and (select private.source_document_event_writable(source_document_id))
  )
  with check (
    (select private.is_reviewer_or_admin())
    and (select private.source_document_event_writable(source_document_id))
  );

-- document_extraction_line_item: final definitions 20260808000026 (update),
-- 20260821000004 (insert), 20260912000002 (delete), plus the event predicate via the
-- parent bill's source_document.
alter policy document_extraction_line_item_insert on public.document_extraction_line_item
  with check (
    (select private.is_reviewer_or_admin())
    and (select private.can_see_document_extraction(document_extraction_id))
    and (select private.extraction_event_writable(document_extraction_id))
  );

alter policy document_extraction_line_item_update on public.document_extraction_line_item
  using (
    (select private.is_reviewer_or_admin())
    and (select private.can_see_document_extraction(document_extraction_id))
    and (select private.extraction_event_writable(document_extraction_id))
  )
  with check (
    (select private.is_reviewer_or_admin())
    and (select private.extraction_event_writable(document_extraction_id))
  );

alter policy document_extraction_line_item_delete on public.document_extraction_line_item
  using (
    (select private.is_reviewer_or_admin())
    and (select private.can_see_document_extraction(document_extraction_id))
    and (select private.extraction_event_writable(document_extraction_id))
  );

-- reconciliation_exception and flags get the same predicate through
-- private.exception_target_writable in section 2.3 below.

-- ============================================================================
-- 2.2 (M3) Only a superadmin can delete a VERIFIED extraction
-- ============================================================================
-- Final definition: 20261005120000 (alter policy ... using). Adds the verified_at guard
-- and the 2.1 event predicate. setPageSkipOverride deletes through this policy; for an
-- admin on a verified or closed-event bill the delete now matches zero rows (RLS filters
-- the row out rather than raising), which the app must report in plain English.
alter policy document_extraction_delete on public.document_extraction
  using (
    (select private.is_reviewer_or_admin())
    and (
      (select private.is_superadmin())
      or source_document_id = any ((select private.visible_source_document_ids())::bigint[])
    )
    and ((select private.is_superadmin()) or verified_at is null)
    and (select private.source_document_event_writable(source_document_id))
  );

-- ============================================================================
-- 2.3 (M4 + D4) reconciliation_exception and flags: integrity + department scope
-- ============================================================================

-- ---- reconciliation_exception ------------------------------------------------------
-- Delete: nobody can delete directly any more. Rows disappear only through FK cascades
-- (RI actions run as the table owner with FORCE RLS suppressed, so they need neither the
-- grant nor a policy) and through private.delete_source_document (security definer).
-- A superadmin-only RPC can be added later if manual deletion is ever needed.
drop policy if exists reconciliation_exception_delete on public.reconciliation_exception;
revoke delete on public.reconciliation_exception from authenticated;

-- Select (D4): admin-or-above sees everything. Anyone else (dept) sees only rows whose
-- entry is in one of their departments, or whose source document / bill is visible to
-- them (private.visible_source_document_ids() is the set form of can_see_source_document).
-- Rows that point at nothing a dept user can see (import-batch-only exceptions, org-wide
-- ones) are therefore hidden from dept.
drop policy if exists reconciliation_exception_select on public.reconciliation_exception;
create policy reconciliation_exception_select on public.reconciliation_exception
  for select to authenticated
  using (
    (select private.is_admin_or_above())
    or (
      (select private.is_staff())
      and (
        exists (
          select 1 from public.entries e
          where e.id = reconciliation_exception.entry_id
            and e.department_id = any ((select private.my_department_ids())::bigint[])
        )
        or source_document_id = any ((select private.visible_source_document_ids())::bigint[])
        or exists (
          select 1 from public.document_extraction de
          where de.id = reconciliation_exception.document_extraction_id
            and de.source_document_id = any ((select private.visible_source_document_ids())::bigint[])
        )
      )
    )
  );

-- Insert / update: reviewer-or-admin (was already the rule) AND every target visible to
-- the caller AND the target's event writable. The same predicate sits in `using` so a
-- bulk resolve (.in('id', ids)) silently skips rows the caller may not touch instead of
-- failing the whole statement on the with-check.
drop policy if exists reconciliation_exception_insert on public.reconciliation_exception;
create policy reconciliation_exception_insert on public.reconciliation_exception
  for insert to authenticated
  with check (
    (select private.is_reviewer_or_admin())
    and (select private.exception_target_writable(
           entry_id, document_extraction_id, source_document_id, import_batch_id))
  );

drop policy if exists reconciliation_exception_update on public.reconciliation_exception;
create policy reconciliation_exception_update on public.reconciliation_exception
  for update to authenticated
  using (
    (select private.is_reviewer_or_admin())
    and (select private.exception_target_writable(
           entry_id, document_extraction_id, source_document_id, import_batch_id))
  )
  with check (
    (select private.is_reviewer_or_admin())
    and (select private.exception_target_writable(
           entry_id, document_extraction_id, source_document_id, import_batch_id))
  );

-- Integrity trigger. For a signed-in caller (auth.uid() not null):
--   * what the exception is about cannot change (type + every target column);
--   * resolved_by / resolved_at cannot be forged: on a status change away from 'open' they
--     are stamped with the real caller and now(); on a reopen they are cleared; if the
--     status did not change they are pinned to their stored values.
-- Service-role / importer / migration writes have no auth.uid() and are left untouched.
-- Columns the app legitimately edits (resolution_note, auto_recheck_*, severity,
-- description, amount_at_risk) are not restricted.
create or replace function private.reconciliation_exception_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    return new;
  end if;

  if new.exception_type is distinct from old.exception_type
     or new.document_extraction_id is distinct from old.document_extraction_id
     or new.entry_id is distinct from old.entry_id
     or new.source_document_id is distinct from old.source_document_id
     or new.import_batch_id is distinct from old.import_batch_id then
    raise exception 'The type and target of an exception cannot be changed.'
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if new.status = 'open' then
      new.resolved_by := null;
      new.resolved_at := null;
    else
      new.resolved_by := v_uid;
      new.resolved_at := now();
    end if;
  else
    new.resolved_by := old.resolved_by;
    new.resolved_at := old.resolved_at;
  end if;

  return new;
end;
$$;

revoke all on function private.reconciliation_exception_guard() from public, anon;

drop trigger if exists reconciliation_exception_guard on public.reconciliation_exception;
create trigger reconciliation_exception_guard
  before update on public.reconciliation_exception
  for each row execute function private.reconciliation_exception_guard();

-- ---- flags ------------------------------------------------------------------------------
-- Select (D4): admin-or-above sees all; dept sees only flags on an entry in one of their
-- departments. Flags with no entry_id (vendor-level: vendor_splitting, tds_threshold, ...)
-- are admin-or-above only. related_entry_ids is deliberately not consulted.
drop policy if exists flags_select on public.flags;
create policy flags_select on public.flags
  for select to authenticated
  using (
    (select private.is_admin_or_above())
    or (
      (select private.is_staff())
      and exists (
        select 1 from public.entries e
        where e.id = flags.entry_id
          and e.department_id = any ((select private.my_department_ids())::bigint[])
      )
    )
  );

-- Update: reviewer-or-admin (was already the rule), entry visible, entry's event writable.
-- No insert/delete policy exists for authenticated and none is added (flags are written by
-- the flags-run worker via the service role).
drop policy if exists flags_update on public.flags;
create policy flags_update on public.flags
  for update to authenticated
  using (
    (select private.is_reviewer_or_admin())
    and (select private.exception_target_writable(entry_id, null, null, null))
  )
  with check (
    (select private.is_reviewer_or_admin())
    and (select private.exception_target_writable(entry_id, null, null, null))
  );

create or replace function private.flags_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    return new;
  end if;

  if new.flag_type is distinct from old.flag_type
     or new.entry_id is distinct from old.entry_id
     or new.dedup_key is distinct from old.dedup_key then
    raise exception 'The type and target of a flag cannot be changed.'
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if new.status = 'open' then
      new.resolved_by := null;
      new.resolved_at := null;
    else
      new.resolved_by := v_uid;
      new.resolved_at := now();
    end if;
  else
    new.resolved_by := old.resolved_by;
    new.resolved_at := old.resolved_at;
  end if;

  return new;
end;
$$;

revoke all on function private.flags_guard() from public, anon;

drop trigger if exists flags_guard on public.flags;
create trigger flags_guard
  before update on public.flags
  for each row execute function private.flags_guard();

-- ============================================================================
-- 2.4 (M11 + D4) Board pack is admin-or-above only
-- ============================================================================
-- Table policy: 20260903000017 (board_pack_select_staff). Storage policy of the same file.
alter policy board_pack_select_staff on public.board_pack
  using ((select private.is_admin_or_above()));

drop policy if exists "staff read board packs" on storage.objects;
create policy "staff read board packs" on storage.objects for select to authenticated
  using (bucket_id = 'board-packs' and (select private.is_admin_or_above()));
-- (Policy name kept so existing references and the Advisors history stay recognisable.)

-- ============================================================================
-- 2.5 (D4) Other staff-wide tables
-- ============================================================================
-- Decision, from grepping app/ components/ lib/ for each table:
--   import_batch, import_row_log     admin-or-above. Readers: /api/import GET (the /import
--                                     page, which only renders for admins), the exceptions
--                                     page's event lookup (per-row, admin-visible rows only)
--                                     and the dashboard "imports today" tile. For dept the
--                                     tile query now simply returns no rows -- the app should
--                                     hide that tile for dept (TypeScript follow-up).
--   status_export_batch / _row       admin-or-above. No app code reads them at all.
--   vendor, vendor_alias, rate_reference   unchanged (D4: vendor list incl. GSTIN stays visible;
--                                     rate benchmarking is deliberately org-wide).
--   app_settings                      unchanged: staff-wide read. It holds only the upload page
--                                     cap (max_upload_pages) which lib/upload-limits.ts reads
--                                     through the session client for the upload dropzone every
--                                     uploader sees; hiding it would break that. Updates are
--                                     already admin-only.
--   approval_threshold                unchanged: staff-wide read. Read by the reports threshold-
--                                     splitting section (lib/reports/surfaces/threshold-
--                                     splitting.ts), and reports are open to every active
--                                     staff member (only the board pack is gated). The table
--                                     is empty today and holds organisation-level limits, not
--                                     per-department data. Writes are already admin-only.
-- The three reporting views that join import_batch use LEFT JOINs (20260822000007,
-- 20260822000010, 20260903000015), so a dept caller just gets a null event for those rows.
alter policy import_batch_select on public.import_batch
  using ((select private.is_admin_or_above()));

alter policy import_row_log_select on public.import_row_log
  using ((select private.is_admin_or_above()));

alter policy status_export_batch_select on public.status_export_batch
  using ((select private.is_admin_or_above()));

alter policy status_export_row_select on public.status_export_row
  using ((select private.is_admin_or_above()));

-- ============================================================================
-- 2.6 (L17) staff_profile self-update: pin its_number and contact_email
-- ============================================================================
-- Final definition of staff_profile_update: 20260819000003 section 5. Superadmin may still
-- change anything; a user editing their own row may change neither (role, is_active) nor
-- (its_number, contact_email) -- its_number is their login identity. Two scalar subqueries
-- instead of a row comparison because the columns are nullable and need IS NOT DISTINCT FROM.
create or replace function private.staff_profile_identity_fields(p_id uuid)
returns table(its_number text, contact_email text)
language sql security definer stable set search_path = '' as $$
  select sp.its_number, sp.contact_email from public.staff_profile sp where sp.id = p_id;
$$;

revoke all on function private.staff_profile_identity_fields(uuid) from public, anon;
grant execute on function private.staff_profile_identity_fields(uuid) to authenticated;

alter policy staff_profile_update on public.staff_profile
  using (id = (select auth.uid()) or (select private.is_superadmin()))
  with check (
    (select private.is_superadmin())
    or (
      id = (select auth.uid())
      and (role, is_active) = (
        select role, is_active from private.staff_profile_locked_fields(id)
      )
      and its_number is not distinct from (
        select f.its_number from private.staff_profile_identity_fields(id) f
      )
      and contact_email is not distinct from (
        select f.contact_email from private.staff_profile_identity_fields(id) f
      )
    )
  );
