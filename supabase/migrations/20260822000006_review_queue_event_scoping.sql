-- Phase 6 Step 2, Stream A (docs/event-scoping-and-review-fixes-plan.md §1,
-- "the multi-year architecture"): the review queue must be filterable by the
-- selected event so a reviewer viewing 1449 H never sees 1448 H's bills (and
-- vice versa).
--
-- Join-vs-denormalize decision (doc §1.2's explicit "decide when the view is
-- rewritten; do not denormalize speculatively"): event is reached by joining
-- through source_document, which v_review_queue/v_review_queue_all already
-- join as `sd` for half a dozen other columns (original_filename,
-- storage_path, page_count, match_status, claimed_by, claimed_at,
-- upload_status). Adding `sd.event_id` costs nothing -- no new join, no new
-- table scan, same plan shape -- so there is no concrete reason to denormalize
-- event_id onto document_extraction. Joining through source_document is kept.
--
-- Filtering itself happens at the query site (app/(app)/review/page.tsx),
-- not inside the view's WHERE clause: the view stays reusable for both the
-- current-event queue and any future cross-event/all-events reporting use,
-- and the app layer already owns "which event is selected" via
-- lib/events/current.ts's cookie-backed getSelectedEventId. This migration
-- only exposes `event_id` as a plain output column on both views so callers
-- can `.eq('event_id', selectedEventId)` against them.
--
-- Correction on review (this migration was drafted, then applied here after
-- an interruption/resume): the drafted v_review_queue had regressed its
-- `entry_id` output, the `entries` join, and the open-exception lateral back
-- to plain `sd.entry_id`, undoing 20260821000002_entry_id_coalesce_fix.sql's
-- `coalesce(de.entry_id, sd.entry_id)` (needed so a per-bill match recorded
-- on `document_extraction.entry_id` for a multi-bill PDF is still picked up).
-- Restored to match the live view; only `event_id` is new here.
-- v_review_queue_all is left as-is -- it never received that coalesce fix
-- (20260821000006_review_queue_all_view.sql created it after 000002 with
-- plain `sd.entry_id`), and reconciling that pre-existing inconsistency is
-- out of scope for this migration.
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
  queue_amount desc nulls last;

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
  queue_amount desc nulls last;

-- v_review_queue_all needed an explicit grant when it was first created
-- (20260821000006 -- a view is its own object, distinct from its base
-- tables, so the broad `grant select ... on all tables in schema public`
-- predating this view does not cover it). CREATE OR REPLACE VIEW does not
-- revoke that grant, but re-stating it here is harmless and keeps this
-- migration self-contained if anyone ever re-runs it against a fresh DB
-- where the grant migration was skipped.
grant select on public.v_review_queue_all to authenticated;
