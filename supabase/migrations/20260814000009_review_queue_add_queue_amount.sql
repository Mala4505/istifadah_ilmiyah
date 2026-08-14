-- Restores `queue_amount` on public.v_review_queue.
--
-- 20260813000001_review_queue_fixes.sql added this column (entries.amount,
-- falling back to the document's own OCR total when unmatched -- see that
-- migration's comment) and app/(app)/review/page.tsx has depended on it ever
-- since for its "queue_amount desc" ordering. Some point after that
-- migration, the view was redefined directly against the database (adding
-- storage_path, page_count, upload_status, invoice_date_ocr, extraction_model,
-- contains_non_latin_script, ubbl_number, department_id, hub_status_id --
-- all genuinely useful, keep them) without a matching migration file and
-- without carrying `queue_amount` forward, which is why /review now fails
-- with "column v_review_queue.queue_amount does not exist" -- CREATE OR
-- REPLACE VIEW only tolerates appending columns, so whatever ran to add
-- those fields necessarily dropped and recreated the view rather than
-- replacing it in place.
--
-- This migration is written against that live shape (confirmed via
-- pg_get_viewdef) rather than reverting to 20260813000001's column list, so
-- it doesn't undo whatever those other fields were added for. It only adds
-- `queue_amount` back, appended at the end -- safe for CREATE OR REPLACE
-- VIEW since every other column stays in its existing position/type -- and
-- restores the view's own ORDER BY (informational only; PostgREST callers,
-- including the review page, always supply their own .order() calls).
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
  coalesce(e.amount, de.total_amount_ocr) as queue_amount
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
order by
  max_open_severity_rank desc,
  r.extraction_confidence asc nulls first,
  queue_amount desc nulls last;

-- CREATE OR REPLACE VIEW does not revoke existing grants, so no re-grant is
-- needed here (matches 20260813000001's note).
