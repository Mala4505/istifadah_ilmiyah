-- Hard delete for source_document (documents inbox: "Delete permanently").
--
-- DELIBERATE DEPARTURE FROM §4.4d. 20260808000026_rls_policies.sql revokes
-- delete on every table in `public` from `authenticated`, on the stated
-- principle that "financial rows are voided, never deleted", and
-- 20260819000001 added match_status='canceled' as the non-destructive way to
-- pull a document out of the inbox. That principle is right for a bill that
-- has been reviewed and booked. It is wrong for the case this function exists
-- for: a mis-scan, a duplicate, or a wrong-file upload that was never anything
-- but noise. Those accumulated in the inbox, kept appearing in the review
-- queue, and kept getting re-extracted at real API cost.
--
-- The revoke stays in place. Deletion is reachable ONLY through this
-- SECURITY DEFINER function, so it remains a single audited entry point rather
-- than a blanket grant -- a stray `.delete()` from application code still
-- fails with permission denied, exactly as 20260808000026 intended.
--
-- ---------------------------------------------------------------------------
-- The one thing it refuses to do
-- ---------------------------------------------------------------------------
-- A document with a VERIFIED extraction (document_extraction.verified_at is
-- not null) is a reviewed financial record: someone checked it and signed off.
-- Deleting it would destroy that sign-off with no undo and no trace, which is
-- the scenario §4.4d is actually protecting against. Those are refused here
-- and can still be canceled (match_status='canceled'), which hides them
-- everywhere without erasing the audit trail.
--
-- If that guard is ever unwanted, delete the `if exists (...) then raise`
-- block below -- nothing else depends on it.
--
-- ---------------------------------------------------------------------------
-- Why the deletes are ordered rather than left to ON DELETE CASCADE
-- ---------------------------------------------------------------------------
-- Most of the chain cascades from source_document already (document_extraction,
-- document_page, ocr_extraction_run, and from document_extraction onward to
-- document_extraction_line_item and reconciliation_exception). Two edges do
-- not, and a bare `delete from source_document` fails on the first of them:
--
--   document_extraction_line_item.document_page_id -> document_page   NO ACTION
--   document_extraction.current_extraction_run_id  -> ocr_extraction_run NO ACTION
--
-- Verified against this database before writing (a plain delete raises
-- 23503 on document_extraction_line_item_document_page_id_fkey). Deleting the
-- line items explicitly first clears both edges, after which the cascade
-- handles the remainder.
--
-- Two things carry no foreign key to source_document at all and would
-- otherwise be orphaned:
--
--   * job_queue -- the document id lives in a jsonb payload, so nothing
--     cascades. Leaving these behind is the bug that made "delete" so
--     ineffective in practice: a canceled document's extract_document job
--     stayed 'queued' and a worker would still pick it up, download the PDF
--     and pay Anthropic to extract a document the user had already discarded.
--   * reconciliation_exception rows raised against the DOCUMENT rather than an
--     extraction (page_count_unresolved:<id>, duplicate_document_hash:<hash>:<id>)
--     have document_extraction_id null, so the cascade never reaches them.
--     Matched on the dedup_key's trailing ':<id>', which cannot collide with a
--     longer id -- ':6' does not match a key ending ':16'.
-- ---------------------------------------------------------------------------

create or replace function private.delete_source_document(p_id bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_storage_path text;
begin
  if exists (
    select 1 from public.document_extraction de
     where de.source_document_id = p_id and de.verified_at is not null
  ) then
    raise exception 'source_document % has a verified extraction and cannot be deleted; cancel it instead', p_id
      using errcode = 'restrict_violation';
  end if;

  -- Clears both NO ACTION edges described above.
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

  -- null => no such row (already deleted, or never visible). The caller
  -- distinguishes that from success by the null return rather than an error,
  -- so deleting the same selection twice is idempotent rather than a failure.
  return v_storage_path;
end;
$$;

-- Callable wrapper, same public/private split as claim_next_job
-- (20260812000001) and sweep_job_queue (20260817000007). The role check lives
-- here rather than in `private` so the privileged body has exactly one gated
-- entry point. `is_admin_or_above` is the post-20260819000003 helper covering
-- admin and superadmin; department staff cannot delete.
create or replace function public.delete_source_document(p_id bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin_or_above() then
    raise exception 'Only an admin can delete a document'
      using errcode = 'insufficient_privilege';
  end if;
  return private.delete_source_document(p_id);
end;
$$;

revoke all on function public.delete_source_document(bigint) from public;
grant execute on function public.delete_source_document(bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- Canceling must also stop the AI
-- ---------------------------------------------------------------------------
-- The non-destructive half of the same bug. 20260819000001 flips match_status
-- to 'canceled' and nothing more, but job_queue holds the document id in a
-- jsonb payload with no foreign key -- so a canceled document's
-- extract_document job stayed 'queued', and the next worker to run downloaded
-- the PDF and paid Anthropic to extract a document the user had already pulled
-- out of the inbox. (Seven such documents were sitting in this database with
-- live jobs when this was written.)
--
-- Needs to be a function for the same reason the delete does: `delete` is
-- revoked on every table in public, so lib/actions/documents.ts cannot issue
-- one directly.
--
-- Only 'queued' rows are removed. A job already 'running' is left alone rather
-- than deleted out from under the handler holding it -- that would strand the
-- handler writing results for a row that no longer exists. It finishes
-- harmlessly, and the document stays hidden either way.
--
-- Reviewer-or-admin rather than admin-only: canceling is already a
-- reviewer-level action (source_document_update's policy), and this is part of
-- that same operation, not a privileged one.
create or replace function public.cancel_source_document_jobs(p_id bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if not private.is_reviewer_or_admin() then
    raise exception 'Only a reviewer or admin can cancel document work'
      using errcode = 'insufficient_privilege';
  end if;

  delete from public.job_queue
   where status = 'queued'
     and job_type = 'extract_document'
     and (payload->>'source_document_id')::bigint = p_id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cancel_source_document_jobs(bigint) from public;
grant execute on function public.cancel_source_document_jobs(bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- v_review_queue: exclude canceled documents
-- ---------------------------------------------------------------------------
-- Separate bug from deletion, fixed here because it has the same cause. The
-- view's only filter is `de.verified_at is null`; it selects sd.match_status
-- but never filters on it, and neither does app/(app)/review/page.tsx nor the
-- dashboard count in app/(app)/page.tsx. 20260819000001's closing note assumed
-- the inbox's `.in('match_status', [...])` filter covered every surface -- it
-- covers the inbox and the unmatched-documents tile, not the review queue. So
-- a canceled document vanished from the inbox and went right on sitting in
-- review. Adding the predicate here fixes both consumers at once, since both
-- read this view.
--
-- Column list is carried over verbatim from 20260817000004_review_queue_multi_bill.sql
-- (the previous migration-tracked definition); the only change is the new
-- match_status predicate in the where clause.
create or replace view public.v_review_queue with (security_invoker = true) as
select
  de.id as document_extraction_id,
  de.source_document_id,
  sd.entry_id,
  sd.original_filename,
  de.current_extraction_run_id,
  r.extraction_confidence,
  r.legibility,
  de.total_amount_ocr,
  de.vendor_name_ocr,
  de.invoice_number_ocr,
  de.created_at,
  coalesce(x.max_severity_rank, 0) as max_open_severity_rank,
  coalesce(x.open_count, 0::bigint) as open_issue_count,
  sd.storage_path,
  sd.page_count,
  sd.match_status,
  sd.claimed_by,
  sd.claimed_at,
  sd.upload_status,
  de.invoice_date_ocr,
  r.model as extraction_model,
  r.contains_non_latin_script,
  e.ubbl_number,
  e.amount as entry_amount,
  e.department_id,
  e.hub_status_id,
  coalesce(e.amount, de.total_amount_ocr) as queue_amount,
  de.bill_index,
  de.page_number_start,
  de.page_number_end,
  count(*) over (partition by de.source_document_id) as bill_count
from public.document_extraction de
join public.source_document sd on sd.id = de.source_document_id
left join public.ocr_extraction_run r on r.id = de.current_extraction_run_id
left join public.entries e on e.id = sd.entry_id
left join lateral (
  select
    count(*) as open_count,
    max(case ex.severity when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end) as max_severity_rank
  from public.reconciliation_exception ex
  where ex.status = 'open'
    and (
      ex.document_extraction_id = de.id
      or (sd.entry_id is not null and ex.entry_id = sd.entry_id)
    )
) x on true
where de.verified_at is null
  and sd.match_status <> 'canceled'
order by
  max_open_severity_rank desc,
  r.extraction_confidence asc nulls first,
  queue_amount desc nulls last;

-- CREATE OR REPLACE VIEW does not revoke existing grants, so no re-grant is
-- needed here (matches 20260814000009's and 20260817000004's notes).
