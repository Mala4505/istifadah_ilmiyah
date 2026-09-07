-- Keep a bill in the pending review queue until all three Review stages are
-- done, not just stage 1 (confirmed with the user 2026-09-07).
--
-- Until now `v_review_queue` filtered `where de.verified_at is null`, so the
-- moment a reviewer saved the extraction (stage 1: Verify) the bill left the
-- queue -- even with no ledger entry attached (stage 2: Connect) and no
-- admin-head/zone/sub-department set on that entry (stage 3: Classify). A
-- half-finished bill then existed only on the document inbox. review-
-- workspace.tsx already treats all three as required (`stage3Done`), and the
-- inbox badge now says "Verified - needs Connect / Classify" for exactly this
-- state; this view is the last piece that still called stage 1 "done".
--
-- New predicate: keep the row when the extraction is unverified OR it is
-- verified but not yet finished. "Finished" mirrors the app's own definition:
--   * the document is marked 'no entry expected' (nothing to connect/classify),
--     OR
--   * the bill resolves to a ledger entry (coalesce(de.entry_id, sd.entry_id),
--     same resolution the rest of this view uses) AND that entry has an
--     admin_head_id, zone_id and sub_department_id.
-- `e` is the view's existing LEFT JOIN on that coalesced entry id, so an
-- unconnected bill sees all-null `e.*` and stays in the queue.
--
-- Everything else in the view -- the exception-matching CTEs, the column
-- list, the ordering, `bill_count` (now "bills in this PDF still needing
-- work", which is what the workspace's "Bill N of M" should mean anyway) --
-- is copied verbatim from 20260904000001_review_queue_perf_rewrite.sql.
--
-- v_review_queue_all is deliberately untouched: it already has no verified
-- filter (only the rolling 2-year bound) and is the superset the "All" toggle
-- reads.
--
-- CREATE OR REPLACE VIEW keeps existing grants (20260814000009's note) -- no
-- re-grant needed.

create or replace view public.v_review_queue with (security_invoker = true) as
with ex_matched_by_extraction as (
  select ex.id as ex_id, de.id as document_extraction_id, ex.severity
  from public.reconciliation_exception ex
  join public.document_extraction de on de.id = ex.document_extraction_id
  where ex.status = 'open'
),
ex_matched_by_entry as (
  select ex.id as ex_id, de.id as document_extraction_id, ex.severity
  from public.reconciliation_exception ex
  join public.document_extraction de on de.entry_id = ex.entry_id
  where ex.status = 'open' and ex.entry_id is not null

  union

  select ex.id as ex_id, de.id as document_extraction_id, ex.severity
  from public.reconciliation_exception ex
  join public.source_document sd on sd.entry_id = ex.entry_id
  join public.document_extraction de on de.source_document_id = sd.id and de.entry_id is null
  where ex.status = 'open' and ex.entry_id is not null
),
open_by_bill as (
  select
    document_extraction_id,
    count(*) as open_count,
    max(case severity when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end) as rank
  from (
    select ex_id, document_extraction_id, severity from ex_matched_by_extraction
    union
    select ex_id, document_extraction_id, severity from ex_matched_by_entry
  ) matched
  group by document_extraction_id
)
select
  de.id as document_extraction_id,
  de.source_document_id,
  coalesce(de.entry_id, sd.entry_id) as entry_id,
  sd.original_filename,
  de.current_extraction_run_id,
  r.extraction_confidence,
  r.legibility,
  de.total_amount_ocr,
  de.vendor_name_ocr,
  de.invoice_number_ocr,
  de.created_at,
  coalesce(x.rank, 0) as max_open_severity_rank,
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
  sd.event_id
from public.document_extraction de
join public.source_document sd on sd.id = de.source_document_id
left join public.ocr_extraction_run r on r.id = de.current_extraction_run_id
left join public.entries e on e.id = coalesce(de.entry_id, sd.entry_id)
left join open_by_bill x on x.document_extraction_id = de.id
where de.verified_at is null
   or not (
     sd.match_status = 'no_entry_expected'
     or (
       coalesce(de.entry_id, sd.entry_id) is not null
       and e.admin_head_id is not null
       and e.zone_id is not null
       and e.sub_department_id is not null
     )
   )
order by
  max_open_severity_rank desc,
  r.extraction_confidence asc nulls first,
  queue_amount desc nulls last,
  de.id asc;
