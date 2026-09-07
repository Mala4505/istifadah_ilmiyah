-- Document assignment -- strict admin scoping (follow-up to 20260829000002).
--
-- 20260829000002 shipped with a compromise: an UNASSIGNED document (no
-- source_document_assignee rows -- "the pool") stayed visible to every
-- admin-or-above, so self-assign from a shared pool was the normal path and
-- rollout day wouldn't show every admin an empty inbox.
--
-- Decision 2026-09-07: reverse that. A non-superadmin admin must see a
-- document ONLY when it is explicitly assigned to them (one assignee or
-- several, as long as they are one of them). The unassigned inbox pool is a
-- superadmin responsibility now -- the superadmin distributes the work; an
-- admin never picks unassigned documents up themselves. `dept` is unchanged:
-- it still self-serves unmatched documents exactly as before.
--
-- This migration only redefines private.can_see_source_document. Everything
-- downstream inherits the new rule with no further change:
--   * source_document_select / document_page / ocr_extraction_run /
--     document_extraction / document_extraction_line_item RLS (20260808000026)
--   * v_review_queue / v_review_queue_all (security_invoker views) -- the
--     review queue re-scopes itself per person
--   * private.set_source_document_assignees's per-row visibility guard
--     (20260829000002 §3) -- a plain admin can no longer self-assign an
--     unassigned document because they can no longer see it, which is
--     exactly the "superadmin assigns them out" intent.

-- ============================================================================
-- can_see_source_document -- pool branch is dept-only now
-- ============================================================================
-- Precedence:
--   superadmin                                  -> every document
--   you are one of the document's assignees     -> that document
--   the document has NO assignees:
--     * it is MATCHED (entry_id is not null)    -> department-scoped, for
--       everyone including admins (can_see_department; an admin whose profile
--       has a null department already sees every department's matched docs,
--       unchanged from before assignment existed)
--     * it is UNMATCHED (the inbox pool)        -> dept only. A non-superadmin
--       admin sees nothing here until a document is assigned to them.
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
          and (select private.is_staff())
          and (
            (sd.entry_id is not null and (select private.can_see_department(e.department_id)))
            or (sd.entry_id is null and not (select private.is_admin_or_above()))
          )
        )
      )
  );
$$;

comment on function private.can_see_source_document(bigint) is
  'Document visibility gate. superadmin: all. Otherwise: documents you are an assignee of, plus (when a document has no assignees) matched documents in a department you can see. An UNMATCHED unassigned document is the inbox pool -- dept self-serves it, a non-superadmin admin does not (they must be assigned it). Strict admin scoping, 2026-09-07 (was: admin-or-above saw the whole pool, 20260829000002).';
