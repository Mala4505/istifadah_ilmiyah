-- ============================================================================
-- §4.1 Helpers
-- ============================================================================
-- Placed here (not in 20260808000002_private_schema_and_helpers.sql) because they
-- query public.staff_profile / public.department, which did not exist that early in
-- the migration order. See the comment in 20260808000002 for the full reasoning.

create or replace function private.is_staff() returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.staff_profile sp
                 where sp.id = (select auth.uid()) and sp.is_active);
$$;

create or replace function private.is_admin() returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.staff_profile sp
                 where sp.id = (select auth.uid()) and sp.is_active and sp.role = 'admin');
$$;

-- null department_id on the profile = access to every department
create or replace function private.can_see_department(dept_id bigint) returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.staff_profile sp
                 where sp.id = (select auth.uid()) and sp.is_active
                   and (sp.department_id is null or sp.department_id = dept_id));
$$;

-- EXTRAPOLATED HELPER (not in §4.1, added here to apply §4.2's pattern to tables §4.2
-- doesn't explicitly cover, per the task's point 4). Reduces the "role in
-- ('admin','reviewer')" exists-subquery, repeated verbatim in the given entries_update
-- policy, to one reusable predicate for every other table below.
create or replace function private.is_reviewer_or_admin() returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.staff_profile sp
                 where sp.id = (select auth.uid()) and sp.is_active and sp.role in ('admin','reviewer'));
$$;

-- EXTRAPOLATED HELPER: department-scoping for the document/OCR chain. entries is the
-- only table that carries department_id directly; source_document, document_page,
-- ocr_extraction_run and document_extraction only reach it via
-- source_document.entry_id, which is itself nullable (documents can arrive before
-- their entry is known, §3.8). Unmatched documents (entry_id is null) are visible to
-- all staff -- that visibility is exactly what the inbox/matching workflow requires;
-- once matched, visibility narrows to the entry's department.
create or replace function private.can_see_source_document(p_source_document_id bigint) returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.source_document sd
    left join public.entries e on e.id = sd.entry_id
    where sd.id = p_source_document_id
      and (sd.entry_id is null or (select private.can_see_department(e.department_id)))
  );
$$;

-- EXTRAPOLATED HELPER: same as above, one hop further for
-- document_extraction_line_item, which reaches source_document via document_extraction.
create or replace function private.can_see_document_extraction(p_document_extraction_id bigint) returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.document_extraction de
    where de.id = p_document_extraction_id
      and (select private.can_see_source_document(de.source_document_id))
  );
$$;

-- EXTRAPOLATED HELPER: anti-privilege-escalation for staff_profile's self-update
-- policy below. A SECURITY DEFINER function reading the *stored* (pre-update) values
-- of the locked columns, so the WITH CHECK comparison doesn't recurse back into
-- staff_profile's own RLS policy.
create or replace function private.staff_profile_locked_fields(p_id uuid)
returns table(role text, department_id bigint, is_active boolean)
language sql security definer stable set search_path = '' as $$
  select sp.role, sp.department_id, sp.is_active from public.staff_profile sp where sp.id = p_id;
$$;

-- ============================================================================
-- §4.2 Table policies
-- ============================================================================

-- ---- entries --------------------------------------------------------------
-- Verbatim from §4.2.
alter table public.entries enable row level security;
alter table public.entries force row level security;

create policy entries_select on public.entries for select to authenticated
  using ((select private.can_see_department(department_id)));

create policy entries_update on public.entries for update to authenticated
  using ((select private.can_see_department(department_id))
         and (select private.is_staff())
         and exists (select 1 from public.staff_profile sp
                     where sp.id = (select auth.uid()) and sp.role in ('admin','reviewer')))
  with check ((select private.can_see_department(department_id)));

-- No delete policy at all. Financial rows are voided (is_void), never removed.
-- INSERT: none -- importers run as service_role and bypass RLS by design.

-- ---- department -------------------------------------------------------------
alter table public.department enable row level security;
alter table public.department force row level security;

-- JUDGEMENT CALL: department is a small, org-wide dimension, not scoped by
-- can_see_department -- that would be circular (can_see_department itself needs
-- department *names* to render department-scoped screens sensibly for a reviewer who
-- can only see their own department). All active staff read the full department list;
-- the actual financial data (entries) stays scoped by entries_select above.
create policy department_select on public.department for select to authenticated
  using ((select private.is_staff()));
-- No insert/update/delete policy: department rows are seeded and grow only via import
-- (service_role) or a future admin screen; deny-by-default for authenticated.

-- ---- head -------------------------------------------------------------------
alter table public.head enable row level security;
alter table public.head force row level security;

create policy head_select on public.head for select to authenticated
  using ((select private.is_staff()) and (select private.can_see_department(department_id)));

-- ---- zone ---------------------------------------------------------------------
alter table public.zone enable row level security;
alter table public.zone force row level security;

create policy zone_select on public.zone for select to authenticated
  using ((select private.is_staff()) and (select private.can_see_department(department_id)));

-- ---- budget_head ----------------------------------------------------------------
alter table public.budget_head enable row level security;
alter table public.budget_head force row level security;

create policy budget_head_select on public.budget_head for select to authenticated
  using ((select private.is_staff())
         and (department_id is null or (select private.can_see_department(department_id))));

-- "Map budget heads -> heads; merge vendors" is admin-only (§4.4c).
create policy budget_head_update_admin on public.budget_head for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

-- ---- vendor -----------------------------------------------------------------------
alter table public.vendor enable row level security;
alter table public.vendor force row level security;

-- JUDGEMENT CALL (task point 4's own example): vendor has no department_id and no path
-- to one -- vendors deliberately span every department (§3.2). Staff-wide read.
create policy vendor_select on public.vendor for select to authenticated
  using ((select private.is_staff()));

-- Vendor identity merges affect payment routing and stay a human, admin decision
-- (§3.2, §4.4c) -- never an automatic fuzzy-match.
create policy vendor_update_admin on public.vendor for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

-- ---- vendor_alias -------------------------------------------------------------------
alter table public.vendor_alias enable row level security;
alter table public.vendor_alias force row level security;

create policy vendor_alias_select on public.vendor_alias for select to authenticated
  using ((select private.is_staff()));
-- No write policy: aliases are recorded by the import/OCR resolution pipeline
-- (service_role) or the admin vendor-merge tooling; deny-by-default for authenticated.

-- ---- entry_status / hub_status --------------------------------------------------------
alter table public.entry_status enable row level security;
alter table public.entry_status force row level security;

create policy entry_status_select on public.entry_status for select to authenticated
  using ((select private.is_staff()));

alter table public.hub_status enable row level security;
alter table public.hub_status force row level security;

create policy hub_status_select on public.hub_status for select to authenticated
  using ((select private.is_staff()));

-- ---- staff_profile ------------------------------------------------------------------
alter table public.staff_profile enable row level security;
alter table public.staff_profile force row level security;

-- Task point 4's own example: users read/update their own row; admins read/update all.
create policy staff_profile_select on public.staff_profile for select to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()));

-- Anti-privilege-escalation: a non-admin editing their own row cannot change role,
-- department_id or is_active -- those must match what is already stored (via the
-- SECURITY DEFINER private.staff_profile_locked_fields helper above, to avoid the
-- check recursing into staff_profile's own RLS). "Manage users, roles, department
-- assignment" is admin-only (§4.4c); this is that rule enforced in the database, not
-- just hidden in the UI.
create policy staff_profile_update on public.staff_profile for update to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()))
  with check (
    (select private.is_admin())
    or (
      id = (select auth.uid())
      and (role, department_id, is_active) = (
        select role, department_id, is_active from private.staff_profile_locked_fields(id)
      )
    )
  );
-- No insert/delete policy for authenticated: rows are created only by
-- private.handle_new_user() (SECURITY DEFINER, bypasses RLS) on first login (§3.8).

-- ---- import_batch / import_row_log --------------------------------------------------
alter table public.import_batch enable row level security;
alter table public.import_batch force row level security;

create policy import_batch_select on public.import_batch for select to authenticated
  using ((select private.is_staff()));
-- No insert/update/delete policy: imports run via service_role in Route Handlers with
-- the secret key (§4.5), which bypasses RLS entirely. "Run an import" being
-- admin-only (§4.4c) is enforced at the application layer, because the writing
-- principal there is never an authenticated Data-API user.

alter table public.import_row_log enable row level security;
alter table public.import_row_log force row level security;

create policy import_row_log_select on public.import_row_log for select to authenticated
  using ((select private.is_staff()));

-- ---- status_export_batch / status_export_row ------------------------------------------
alter table public.status_export_batch enable row level security;
alter table public.status_export_batch force row level security;

create policy status_export_batch_select on public.status_export_batch for select to authenticated
  using ((select private.is_staff()));
-- "Generate a status export batch" is admin-only (§4.4c).
create policy status_export_batch_insert_admin on public.status_export_batch for insert to authenticated
  with check ((select private.is_admin()));
create policy status_export_batch_update_admin on public.status_export_batch for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

alter table public.status_export_row enable row level security;
alter table public.status_export_row force row level security;

create policy status_export_row_select on public.status_export_row for select to authenticated
  using ((select private.is_staff()));
create policy status_export_row_insert_admin on public.status_export_row for insert to authenticated
  with check ((select private.is_admin()));
-- No update/delete: "a delivered export is never rewritten" (§3.7).

-- ---- entry_change_log ---------------------------------------------------------------
alter table public.entry_change_log enable row level security;
alter table public.entry_change_log force row level security;

create policy entry_change_log_select on public.entry_change_log for select to authenticated
  using (
    (select private.is_staff())
    and (select private.can_see_department(
           (select e.department_id from public.entries e where e.id = entry_change_log.entry_id)
         ))
  );
-- No write policy for authenticated: rows are written exclusively by
-- private.log_entry_change() (SECURITY DEFINER, 20260808000017), never directly --
-- the entire point of the table is that it cannot be edited after the fact.

-- ---- budget_allocation ---------------------------------------------------------------
alter table public.budget_allocation enable row level security;
alter table public.budget_allocation force row level security;

create policy budget_allocation_select on public.budget_allocation for select to authenticated
  using (
    (select private.is_staff())
    and exists (
      select 1 from public.budget_head bh
      where bh.id = budget_allocation.budget_head_id
        and (bh.department_id is null or (select private.can_see_department(bh.department_id)))
    )
  );
-- No write policy: append-only snapshots written by the importer (service_role).

-- ---- source_document ------------------------------------------------------------------
alter table public.source_document enable row level security;
alter table public.source_document force row level security;

create policy source_document_select on public.source_document for select to authenticated
  using ((select private.is_staff()) and (select private.can_see_source_document(id)));

-- "Attach documents to entries / manage the inbox" is reviewer/admin (§4.4c). Ingest
-- may also happen through a Route Handler under service_role (bypasses RLS); this
-- policy covers direct writes from the signed-in app.
create policy source_document_insert on public.source_document for insert to authenticated
  with check ((select private.is_reviewer_or_admin()));
create policy source_document_update on public.source_document for update to authenticated
  using ((select private.is_reviewer_or_admin()) and (select private.can_see_source_document(id)))
  with check ((select private.is_reviewer_or_admin()));

-- ---- document_page ------------------------------------------------------------------
alter table public.document_page enable row level security;
alter table public.document_page force row level security;

create policy document_page_select on public.document_page for select to authenticated
  using ((select private.is_staff()) and (select private.can_see_source_document(source_document_id)));
create policy document_page_update on public.document_page for update to authenticated
  using ((select private.is_reviewer_or_admin())
         and (select private.can_see_source_document(source_document_id)))
  with check ((select private.is_reviewer_or_admin()));
-- No insert/delete for authenticated: pages are created by the ingest/rasterise
-- pipeline (service_role); update exists only so a reviewer can correct
-- is_financial_document/skip_reason during triage.

-- ---- ocr_extraction_run --------------------------------------------------------------
alter table public.ocr_extraction_run enable row level security;
alter table public.ocr_extraction_run force row level security;

create policy ocr_extraction_run_select on public.ocr_extraction_run for select to authenticated
  using ((select private.is_staff()) and (select private.can_see_source_document(source_document_id)));
-- No write policy: written exclusively by the OCR worker (service_role). Manual
-- re-escalation still goes through the service-role-backed job queue, not a direct
-- client write, so no reviewer write policy is needed here either.

-- ---- document_extraction --------------------------------------------------------------
alter table public.document_extraction enable row level security;
alter table public.document_extraction force row level security;

create policy document_extraction_select on public.document_extraction for select to authenticated
  using ((select private.is_staff()) and (select private.can_see_source_document(source_document_id)));

-- "Verify document extractions" is reviewer/admin (§4.4c) -- this is the verify
-- screen writing the _verified columns.
create policy document_extraction_update on public.document_extraction for update to authenticated
  using ((select private.is_reviewer_or_admin())
         and (select private.can_see_source_document(source_document_id)))
  with check ((select private.is_reviewer_or_admin()));
-- No insert/delete for authenticated: rows are created by the OCR pipeline (service_role).

-- ---- document_extraction_line_item -----------------------------------------------------
alter table public.document_extraction_line_item enable row level security;
alter table public.document_extraction_line_item force row level security;

create policy document_extraction_line_item_select on public.document_extraction_line_item for select to authenticated
  using ((select private.is_staff())
         and (select private.can_see_document_extraction(document_extraction_id)));
create policy document_extraction_line_item_update on public.document_extraction_line_item for update to authenticated
  using ((select private.is_reviewer_or_admin())
         and (select private.can_see_document_extraction(document_extraction_id)))
  with check ((select private.is_reviewer_or_admin()));

-- ---- reconciliation_exception -----------------------------------------------------------
alter table public.reconciliation_exception enable row level security;
alter table public.reconciliation_exception force row level security;

-- JUDGEMENT CALL: entry_id, document_extraction_id and import_batch_id are all
-- nullable -- some exception types (e.g. 'allocation_sum_mismatch') don't resolve to a
-- single entry at all. Precise department scoping isn't reliably derivable in every
-- case, and hiding a systemic exception from another department's reviewers is a worse
-- failure mode than over-sharing an operational issue list. Staff-wide read;
-- resolve/dismiss stays reviewer/admin (§4.4c).
create policy reconciliation_exception_select on public.reconciliation_exception for select to authenticated
  using ((select private.is_staff()));
create policy reconciliation_exception_update on public.reconciliation_exception for update to authenticated
  using ((select private.is_reviewer_or_admin()))
  with check ((select private.is_reviewer_or_admin()));

-- ---- rate_reference ---------------------------------------------------------------------
alter table public.rate_reference enable row level security;
alter table public.rate_reference force row level security;

-- JUDGEMENT CALL: vendor_id is not null but vendors are not department-scoped (§3.2),
-- and entry_id is nullable. Rate benchmarking is also explicitly meant to compare
-- rates *across* the whole event (§3.10) -- department-scoping it would defeat its
-- purpose. Staff-wide read; no write policy (populated by the import/OCR pipeline,
-- service_role).
create policy rate_reference_select on public.rate_reference for select to authenticated
  using ((select private.is_staff()));

-- ---- flags -------------------------------------------------------------------------------
alter table public.flags enable row level security;
alter table public.flags force row level security;

create policy flags_select on public.flags for select to authenticated
  using ((select private.is_staff()));
create policy flags_update on public.flags for update to authenticated
  using ((select private.is_reviewer_or_admin()))
  with check ((select private.is_reviewer_or_admin()));

-- ---- job_queue -----------------------------------------------------------------------------
alter table public.job_queue enable row level security;
alter table public.job_queue force row level security;

-- JUDGEMENT CALL: job_queue is pure background-worker infrastructure with no FK to
-- anything (payload is a plain jsonb blob, §3.11). No ordinary staff need ever query
-- it; admins may, for an operational "queue health" view. All writes happen via
-- service_role (the worker claims/completes jobs with the secret key, §4.5) -- no
-- write policy for authenticated at all.
create policy job_queue_select_admin on public.job_queue for select to authenticated
  using ((select private.is_admin()));

-- ============================================================================
-- §4.4c Roles and permissions -- groundwork
-- ============================================================================
-- Supabase's platform-level default privileges already grant broad table access to
-- anon/authenticated/service_role on newly created tables in `public`, and
-- `service_role` itself carries the BYPASSRLS role attribute regardless of any GRANT
-- or `force row level security` above (§4.5). The statements below are added
-- defensively so this migration file is self-contained and does not silently depend on
-- an unstated platform default. RLS (enabled + forced per table above) remains the
-- actual gate: granting a privilege here does nothing for a table/action that has no
-- matching permissive policy -- deny-by-default holds throughout.
grant usage on schema public to authenticated;
grant select, insert, update on all tables in schema public to authenticated;
-- No table in this schema has a delete policy anywhere (financial rows are voided,
-- never deleted; audit and export rows are permanent by design, §4.4d) -- delete is
-- revoked outright rather than left to "no policy = denied", so a future accidental
-- delete policy fails loudly (permission denied) instead of silently becoming live.
revoke delete on all tables in schema public from authenticated;
grant usage, select on all sequences in schema public to authenticated;
