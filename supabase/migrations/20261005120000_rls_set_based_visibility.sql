-- RLS: set-based visibility instead of per-row helper calls.
--
-- Problem (measured 2026-10-05 on the live DB): every policy below called
-- private.can_see_department(<row col>) or private.can_see_source_document(<row col>)
-- once PER ROW. Wrapping in `(select ...)` only caches a call whose arguments
-- don't reference the row, so these never cached. Each call is a SECURITY
-- DEFINER SQL function (not inlinable, ~2ms each, and they nest), so
-- `select count(*) from v_review_queue where event_id = 1` took 9.75s as an
-- admin -- over the 8s `authenticated` statement_timeout -- for 182 rows.
-- pg_stat_statements: source_document_assignee (288 rows) had 6 billion
-- tuples read; match_candidate_entries averaged 1.8s over 41k calls.
--
-- Fix: compute "what can this user see" ONCE per statement as an array
-- (an uncorrelated `(select fn())` becomes an InitPlan), and compare each
-- row's column against it. NB: `= any ((select fn())::bigint[])` -- the
-- cast is required; bare `= any ((select fn()))` parses as ANY(subquery).
-- Admin/superadmin short-circuits are also uncorrelated InitPlans, so the
-- array is never built for them.
--
-- Semantics are UNCHANGED:
--   can_see_department(d)       == is_admin_or_above() OR d = any(my_department_ids())
--   can_see_source_document(s)  == is_superadmin() OR s = any(visible_source_document_ids())
-- (null d: both forms are false/null for non-admins, i.e. row hidden.)
-- private.can_see_* functions are kept -- RPCs and triggers still call them
-- for single-row checks, where they're fine.

-- ---------------------------------------------------------------------------
-- 1. Set-returning helpers
-- ---------------------------------------------------------------------------

create or replace function private.my_department_ids()
returns bigint[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(sd.department_id), '{}'::bigint[])
  from public.staff_profile sp
  join public.staff_department sd on sd.staff_id = sp.id
  where sp.id = (select auth.uid()) and sp.is_active;
$$;

-- Set form of private.can_see_source_document -- same branches, same order.
create or replace function private.visible_source_document_ids()
returns bigint[]
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select
      (select auth.uid()) as uid,
      private.is_superadmin() as is_superadmin,
      private.is_staff() as is_staff,
      private.is_admin_or_above() as is_admin_or_above,
      private.my_department_ids() as department_ids
  )
  select coalesce(array_agg(sd.id), '{}'::bigint[])
  from public.source_document sd, me
  where
    me.is_superadmin
    or exists (
      select 1 from public.source_document_assignee sda
      where sda.source_document_id = sd.id
        and sda.staff_id = me.uid
    )
    or (
      not exists (
        select 1 from public.source_document_assignee sda
        where sda.source_document_id = sd.id
      )
      and me.is_staff
      and (
        case
          when exists (
            select 1 from public.entry_bill_link l where l.source_document_id = sd.id
          )
          then exists (
            select 1
            from public.entry_bill_link l
            join public.entries e on e.id = l.entry_id
            where l.source_document_id = sd.id
              and (me.is_admin_or_above or e.department_id = any (me.department_ids))
          )
          else not me.is_admin_or_above
        end
      )
    );
$$;

revoke all on function private.my_department_ids() from public, anon;
revoke all on function private.visible_source_document_ids() from public, anon;
grant execute on function private.my_department_ids() to authenticated;
grant execute on function private.visible_source_document_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Department-scoped policies
--    DEPT(x) := ((select private.is_admin_or_above()) or x = any ((select private.my_department_ids())::bigint[]))
-- ---------------------------------------------------------------------------

alter policy entries_select on public.entries
  using (
    (select private.is_admin_or_above())
    or department_id = any ((select private.my_department_ids())::bigint[])
  );

alter policy entries_insert on public.entries
  with check (
    (select private.is_staff())
    and department_id is not null
    and (
      (select private.is_admin_or_above())
      or department_id = any ((select private.my_department_ids())::bigint[])
    )
    and source = 'manual'
  );

alter policy entries_update on public.entries
  using (
    (
      (select private.is_admin_or_above())
      or department_id = any ((select private.my_department_ids())::bigint[])
    )
    and (select private.is_admin_or_above())
  )
  with check (
    (select private.is_admin_or_above())
    or department_id = any ((select private.my_department_ids())::bigint[])
  );

alter policy budget_head_select on public.budget_head
  using (
    (select private.is_staff())
    and (
      department_id is null
      or (select private.is_admin_or_above())
      or department_id = any ((select private.my_department_ids())::bigint[])
    )
  );

alter policy budget_allocation_select on public.budget_allocation
  using (
    (select private.is_staff())
    and exists (
      select 1 from public.budget_head bh
      where bh.id = budget_allocation.budget_head_id
        and (
          bh.department_id is null
          or (select private.is_admin_or_above())
          or bh.department_id = any ((select private.my_department_ids())::bigint[])
        )
    )
  );

alter policy sub_department_select on public.sub_department
  using (
    (select private.is_staff())
    and (
      (select private.is_admin_or_above())
      or department_id = any ((select private.my_department_ids())::bigint[])
    )
  );

alter policy entry_change_log_select on public.entry_change_log
  using (
    (select private.is_staff())
    and (
      (select private.is_admin_or_above())
      or (
        select e.department_id from public.entries e
        where e.id = entry_change_log.entry_id
      ) = any ((select private.my_department_ids())::bigint[])
    )
  );

alter policy reimbursement_detail_select on public.reimbursement_detail
  using (
    exists (
      select 1 from public.entries e
      where e.id = reimbursement_detail.entry_id
        and (
          (select private.is_admin_or_above())
          or e.department_id = any ((select private.my_department_ids())::bigint[])
        )
    )
  );

alter policy advance_payment_detail_select on public.advance_payment_detail
  using (
    exists (
      select 1 from public.entries e
      where e.id = advance_payment_detail.entry_id
        and (
          (select private.is_admin_or_above())
          or e.department_id = any ((select private.my_department_ids())::bigint[])
        )
    )
  );

alter policy invoice_against_uplaq_detail_select on public.invoice_against_uplaq_detail
  using (
    exists (
      select 1 from public.entries e
      where e.id = invoice_against_uplaq_detail.entry_id
        and (
          (select private.is_admin_or_above())
          or e.department_id = any ((select private.my_department_ids())::bigint[])
        )
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Source-document-scoped policies
--    DOC(x) := ((select private.is_superadmin()) or x = any ((select private.visible_source_document_ids())::bigint[]))
-- ---------------------------------------------------------------------------

alter policy source_document_select on public.source_document
  using (
    (select private.is_staff())
    and (
      (select private.is_superadmin())
      or id = any ((select private.visible_source_document_ids())::bigint[])
    )
  );

alter policy source_document_update on public.source_document
  using (
    (select private.is_reviewer_or_admin())
    and (
      (select private.is_superadmin())
      or id = any ((select private.visible_source_document_ids())::bigint[])
    )
  );

alter policy document_page_select on public.document_page
  using (
    (select private.is_staff())
    and (
      (select private.is_superadmin())
      or source_document_id = any ((select private.visible_source_document_ids())::bigint[])
    )
  );

alter policy document_page_update on public.document_page
  using (
    (select private.is_reviewer_or_admin())
    and (
      (select private.is_superadmin())
      or source_document_id = any ((select private.visible_source_document_ids())::bigint[])
    )
  );

alter policy ocr_extraction_run_select on public.ocr_extraction_run
  using (
    (select private.is_staff())
    and (
      (select private.is_superadmin())
      or source_document_id = any ((select private.visible_source_document_ids())::bigint[])
    )
  );

alter policy document_extraction_select on public.document_extraction
  using (
    (select private.is_staff())
    and (
      (select private.is_superadmin())
      or source_document_id = any ((select private.visible_source_document_ids())::bigint[])
    )
  );

alter policy document_extraction_update on public.document_extraction
  using (
    (select private.is_reviewer_or_admin())
    and (
      (select private.is_superadmin())
      or source_document_id = any ((select private.visible_source_document_ids())::bigint[])
    )
  );

alter policy document_extraction_delete on public.document_extraction
  using (
    (select private.is_reviewer_or_admin())
    and (
      (select private.is_superadmin())
      or source_document_id = any ((select private.visible_source_document_ids())::bigint[])
    )
  );

-- can_see_entry(id) == the entry exists and DEPT(its department). The
-- exists() below reads entries under its own (now set-based) RLS, which is
-- that same department check.
alter policy entry_bill_link_select on public.entry_bill_link
  using (
    (
      (select private.is_superadmin())
      or source_document_id = any ((select private.visible_source_document_ids())::bigint[])
    )
    and exists (
      select 1 from public.entries e
      where e.id = entry_bill_link.entry_id
        and (
          (select private.is_admin_or_above())
          or e.department_id = any ((select private.my_department_ids())::bigint[])
        )
    )
  );
