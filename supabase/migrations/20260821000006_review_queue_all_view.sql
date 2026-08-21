-- Review page layout redesign plan §1: the document position counter and
-- Prev/Next on /review currently silently operate over v_review_queue, which
-- is already unverified-only (`where de.verified_at is null`,
-- 20260817000004_review_queue_multi_bill.sql). There is no "All documents"
-- superset anywhere, so the decision to default the queue to
-- pending-only with an explicit Unverified/All toggle needs a second view,
-- not just a relabeled query.
--
-- v_review_queue_all is the exact same SELECT/FROM/JOINs/lateral-join as
-- v_review_queue, minus the verified_at filter, plus de.verified_at itself
-- so callers can tell verified rows apart once they're included.
create or replace view public.v_review_queue_all with (security_invoker = true) as
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
  count(*) over (partition by de.source_document_id) as bill_count,
  de.verified_at
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
order by
  max_open_severity_rank desc,
  r.extraction_confidence asc nulls first,
  queue_amount desc nulls last;

-- A view is its own object, distinct from its base tables -- the broad
-- `grant select ... on all tables in schema public` in
-- 20260808000026_rls_policies.sql ran long before this view existed, so it
-- does not cover it. Without an explicit grant here, PostgREST would return
-- "permission denied" even though security_invoker RLS would otherwise allow
-- the rows (same reasoning as 20260817000001_entry_status_counts_view.sql's
-- grant block).
grant select on public.v_review_queue_all to authenticated;
