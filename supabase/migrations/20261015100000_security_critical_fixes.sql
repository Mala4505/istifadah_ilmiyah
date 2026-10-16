-- Security audit 2026-10-15, Phase 1: critical/high database fixes.
-- Plan: docs/security-audit-fix-plan.md (Phase 1, tasks 1.1-1.4; owner decisions D1, D3, D5).
--
--   1.1 (C1) handle_new_user must trust only server-controlled metadata.
--   1.2 (H1) invoice-documents bucket: no direct access for any signed-in role.
--   1.3 (H3) delete_source_document / cancel_source_document_jobs check visibility
--            and the document's event (closed events: superadmin only).
--   1.4 (L11) revoke anon/public EXECUTE on the four security-definer wrappers.
--
-- DEPLOY ORDER: push this migration, then deploy the app code immediately.
-- Task 1.1 is only half the fix -- lib/actions/admin.ts createStaffUser must move
-- role / is_active / department_ids / its_number / contact_email from
-- `user_metadata` to `app_metadata` (keeping only full_name in user_metadata). Until
-- that code ships, a user created through the admin screen lands as an inactive `dept`.
--
-- Everything below is idempotent (create or replace / drop ... if exists / revoke+grant).

-- ============================================================================
-- 1.1 (C1) private.handle_new_user -- role & friends come from raw_app_meta_data
-- ============================================================================
-- Last definition: 20260819000003_role_rbac_v2.sql section 7. It copied role,
-- is_active, department_ids, its_number and contact_email out of
-- raw_user_meta_data, which is the field a caller controls on a public signUp
-- (and later through auth.updateUser). raw_app_meta_data can only be written with
-- the service key (auth.admin.createUser({ app_metadata })), so reading the
-- privileged keys from there closes the self-registered-superadmin hole even if
-- signup is ever re-enabled. full_name is cosmetic and stays in user_metadata.
-- Defaults are unchanged: role 'dept', is_active false.
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
    coalesce(new.raw_app_meta_data->>'role', 'dept'),
    coalesce((new.raw_app_meta_data->>'is_active')::boolean, false),
    new.raw_app_meta_data->>'its_number',
    new.raw_app_meta_data->>'contact_email'
  )
  on conflict (id) do nothing;

  if jsonb_typeof(new.raw_app_meta_data->'department_ids') = 'array' then
    for v_department_id in
      select value::bigint from jsonb_array_elements_text(new.raw_app_meta_data->'department_ids')
    loop
      insert into public.staff_department (staff_id, department_id)
      values (new.id, v_department_id)
      on conflict do nothing;
    end loop;
  end if;

  return new;
end; $$;

-- ============================================================================
-- 1.2 (H1) invoice-documents: service role only
-- ============================================================================
-- 20260808000027_storage_policies.sql let ANY active staff member list, download,
-- upload and overwrite every object in the bucket with their own token. The app
-- never needs that: every storage call in app/ components/ lib/ runs through
-- lib/storage.ts (service-role client) or hands the browser a signed URL minted
-- by that client (createSignedUploadUrl / createSignedUrl). Both keep working
-- because the service role bypasses storage RLS. With no policy left for
-- `authenticated`, deny-by-default applies to select/insert/update/delete.
drop policy if exists "staff read documents"    on storage.objects;
drop policy if exists "staff upload documents"  on storage.objects;
drop policy if exists "staff replace documents" on storage.objects;
drop policy if exists "admins delete documents" on storage.objects;

-- Bucket limits (also in dashboard step 0.4): 32 MiB, PDF only. The browser PUTs
-- with content-type application/pdf (components/documents/upload-dropzone.tsx),
-- and only PDFs are ever written to this bucket.
update storage.buckets
   set file_size_limit = 33554432,
       allowed_mime_types = array['application/pdf']
 where id = 'invoice-documents';

-- ============================================================================
-- 1.3 (H3) delete_source_document / cancel_source_document_jobs
-- ============================================================================
-- Body of private.delete_source_document is the final one from
-- 20261006140000_superadmin_delete_verified_document.sql, with two guards added at
-- the top (D5: closed events are superadmin-only):
--   * the document must be visible to the caller (private.can_see_source_document
--     -- final definition 20260908000003 section 8: superadmin, assignee, or the
--     unassigned pool the caller's departments can see);
--   * a non-superadmin may only act on a document in the current event.
-- A document that no longer exists still returns null (idempotent delete, see
-- 20260820000001 and lib/actions/documents.ts deleteDocuments) instead of raising.
-- The public wrapper (admin-or-above role check) is unchanged.
create or replace function private.delete_source_document(p_id bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_storage_path text;
  v_event_id bigint;
begin
  select sd.event_id into v_event_id
    from public.source_document sd
   where sd.id = p_id;
  if not found then
    return null;
  end if;

  if not (select private.can_see_source_document(p_id)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not (select private.is_superadmin()) and not exists (
       select 1 from public.event e where e.id = v_event_id and e.is_current) then
    raise exception 'event is closed' using errcode = '42501';
  end if;

  if not (select private.is_superadmin()) and exists (
    select 1 from public.document_extraction de
     where de.source_document_id = p_id and de.verified_at is not null
  ) then
    raise exception 'source_document % has a verified extraction and cannot be deleted; cancel it instead', p_id
      using errcode = 'restrict_violation';
  end if;

  -- Rate history derived from this document's line items (NO ACTION edge).
  delete from public.rate_reference rr
   using public.document_extraction_line_item li
     join public.document_extraction de on de.id = li.document_extraction_id
   where rr.line_item_id = li.id
     and de.source_document_id = p_id;

  -- Clears the two NO ACTION edges described in 20260820000001. Matched via
  -- the extraction as well as the page, since a line item's page id can be null.
  delete from public.document_extraction_line_item li
   using public.document_extraction de
   where li.document_extraction_id = de.id
     and de.source_document_id = p_id;

  delete from public.document_extraction_line_item li
   using public.document_page dp
   where li.document_page_id = dp.id
     and dp.source_document_id = p_id;

  -- Document-scoped exceptions the cascade cannot reach.
  delete from public.reconciliation_exception
   where dedup_key like '%:' || p_id::text;

  -- Stops any worker from extracting a document that no longer exists.
  delete from public.job_queue
   where (payload->>'source_document_id')::bigint = p_id;

  delete from public.source_document
   where id = p_id
   returning storage_path into v_storage_path;

  return v_storage_path;
end;
$$;

-- cancel_source_document_jobs: body from 20260820000001 (public wrapper, role check
-- is_reviewer_or_admin), plus the same visibility + closed-event guards.
create or replace function public.cancel_source_document_jobs(p_id bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
  v_event_id bigint;
begin
  if not private.is_reviewer_or_admin() then
    raise exception 'Only a reviewer or admin can cancel document work'
      using errcode = 'insufficient_privilege';
  end if;

  select sd.event_id into v_event_id
    from public.source_document sd
   where sd.id = p_id;
  if not found then
    return 0;
  end if;

  if not (select private.can_see_source_document(p_id)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not (select private.is_superadmin()) and not exists (
       select 1 from public.event e where e.id = v_event_id and e.is_current) then
    raise exception 'event is closed' using errcode = '42501';
  end if;

  delete from public.job_queue
   where status = 'queued'
     and job_type = 'extract_document'
     and (payload->>'source_document_id')::bigint = p_id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ============================================================================
-- 1.4 (L11) no anon / public EXECUTE on the definer wrappers
-- ============================================================================
-- Supabase's default privileges grant EXECUTE on new public functions to anon
-- explicitly (see 20260814000004), and revoking from PUBLIC alone does not remove
-- that. Each function checks the caller's role internally, so this is defence in
-- depth (and clears the Advisors "anon_security_definer_function_executable"
-- warnings). authenticated keeps EXECUTE -- the app calls all four with the
-- signed-in session.
--   delete_source_document(bigint)                    20260820000001:109
--   cancel_source_document_jobs(bigint)               20260820000001:150
--   set_source_document_assignees(bigint[], uuid[])   20260829000002:210
--   next_manual_ubbl_number()                         20260819000002:38 (security INVOKER;
--       anon has no sequence grant so it could never succeed, but the advisor still lists it)
revoke execute on function public.delete_source_document(bigint)                  from public, anon;
revoke execute on function public.cancel_source_document_jobs(bigint)             from public, anon;
revoke execute on function public.set_source_document_assignees(bigint[], uuid[]) from public, anon;
revoke execute on function public.next_manual_ubbl_number()                        from public, anon;

grant execute on function public.delete_source_document(bigint)                  to authenticated;
grant execute on function public.cancel_source_document_jobs(bigint)             to authenticated;
grant execute on function public.set_source_document_assignees(bigint[], uuid[]) to authenticated;
grant execute on function public.next_manual_ubbl_number()                        to authenticated;
