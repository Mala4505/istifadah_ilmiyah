-- Hub screen certification, Wave 1 item 1.1 (docs/hub-screen-certification.md
-- §3): v_review_queue and v_review_queue_all order by severity rank, then
-- confidence, then amount, and stop there. The common case -- no open
-- exceptions (rank 0), no extraction run (null confidence), no amount (null)
-- -- puts every such bill into a single tie group that Postgres may return in
-- any order. That nondeterminism shows up three ways: "Bill N of M" drifts
-- between navigations, prevId/nextId can point at different bills on each
-- round trip, and because app/(app)/review/page.tsx applies LIMIT 500 to an
-- unstable order, a different 500 rows can come back on each request -- a
-- bill can become effectively unreachable. Adding `de.id` as a final
-- tiebreaker makes the order fully deterministic; page.tsx's queueQuery
-- gets the matching `.order('document_extraction_id', { ascending: true })`
-- in the same change.
--
-- Bodies below are copied verbatim from
-- 20260822000006_review_queue_event_scoping.sql (the current live
-- definition of both views) -- only the final `order by` clause changes.
create or replace view public.v_review_queue with (security_invoker = true) as
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
  sd.event_id
from public.document_extraction de
join public.source_document sd on sd.id = de.source_document_id
left join public.ocr_extraction_run r on r.id = de.current_extraction_run_id
left join public.entries e on e.id = coalesce(de.entry_id, sd.entry_id)
left join lateral (
  select
    count(*) as open_count,
    max(case ex.severity when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end) as max_severity_rank
  from public.reconciliation_exception ex
  where ex.status = 'open'
    and (
      ex.document_extraction_id = de.id
      or (
        coalesce(de.entry_id, sd.entry_id) is not null
        and ex.entry_id = coalesce(de.entry_id, sd.entry_id)
      )
    )
) x on true
where de.verified_at is null
order by
  max_open_severity_rank desc,
  r.extraction_confidence asc nulls first,
  queue_amount desc nulls last,
  de.id asc;

-- CREATE OR REPLACE VIEW does not revoke existing grants (matches
-- 20260814000009's/20260817000004's note) -- no re-grant needed here.

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
  de.verified_at,
  sd.event_id
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
  queue_amount desc nulls last,
  de.id asc;

-- v_review_queue_all needed an explicit grant when it was first created
-- (20260821000006 -- a view is its own object, distinct from its base
-- tables, so the broad `grant select ... on all tables in schema public`
-- predating this view does not cover it). CREATE OR REPLACE VIEW does not
-- revoke that grant, but re-stating it here is harmless and keeps this
-- migration self-contained if anyone ever re-runs it against a fresh DB
-- where the grant migration was skipped.
grant select on public.v_review_queue_all to authenticated;
