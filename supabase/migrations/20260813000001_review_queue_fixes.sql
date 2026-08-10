-- Day 4 review queue (§7, §11.2 Day 4). Fixes v_review_queue
-- (20260808000028_reporting_views.sql) rather than replacing it wholesale --
-- CREATE OR REPLACE VIEW only tolerates appending columns at the end, not
-- reordering/removing existing ones, so every original column stays in its
-- original position/type below and the new ones are appended.
--
-- Two real bugs fixed, found while building the screen that is this view's
-- only consumer so far (app/(app)/page.tsx only ever does a head-count
-- select, which is unaffected by either fix):
--
-- 1. The exception join grouped by `entry_id` and filtered `entry_id is not
--    null`. But most exceptions raised by the tally checks in
--    lib/jobs/handlers/extract.ts ('line_item_tally_mismatch',
--    'other'/legibility) carry `document_extraction_id` and leave `entry_id`
--    null -- only 'ocr_total_vs_amount' sets both. The old join silently
--    excluded exactly the exceptions §7's "open exception severity ↓"
--    ordering most needs to see. Fixed to match on EITHER key via a lateral
--    join (a plain OR filter, so a row satisfying both never double-counts).
-- 2. §7 orders by "tenant amount ↓", i.e. entries.amount -- the OLD view
--    ordered by de.total_amount_ocr (the document's own OCR figure), which
--    is also the only figure available for the ~18-of-21-sample documents
--    that arrive with no matching entry yet (§1). `queue_amount` below is
--    entries.amount when matched, falling back to the document's own OCR
--    total when not -- the literal spec value where it exists, a sane
--    substitute where it doesn't.
--
-- The view's own `order by` is retained for anyone querying it directly, but
-- the review page (app/(app)/review/page.tsx) reissues the same three
-- `.order()` calls explicitly -- a view's internal ORDER BY is not part of
-- the SQL contract once PostgREST wraps it in its own query.
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
  coalesce(iss.max_severity_rank, 0) as max_open_severity_rank,
  coalesce(iss.open_issue_count, 0) as open_issue_count,
  -- appended columns (safe for CREATE OR REPLACE VIEW: names/types below are new)
  sd.claimed_by,
  sd.claimed_at,
  sd.match_status,
  e.amount as entry_amount,
  e.ubbl_number as entry_ubbl_number,
  e.department_id as entry_department_id,
  coalesce(e.amount, de.total_amount_ocr) as queue_amount
from public.document_extraction de
join public.source_document sd on sd.id = de.source_document_id
left join public.ocr_extraction_run r on r.id = de.current_extraction_run_id
left join public.entries e on e.id = sd.entry_id
left join lateral (
  select
    count(*) as open_issue_count,
    max(case re.severity when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end) as max_severity_rank
  from public.reconciliation_exception re
  where re.status = 'open'
    and (
      re.document_extraction_id = de.id
      or (sd.entry_id is not null and re.entry_id = sd.entry_id)
    )
) iss on true
where de.verified_at is null
order by
  max_open_severity_rank desc,
  r.extraction_confidence asc nulls first,
  queue_amount desc nulls last;

-- The blanket `grant select on <views> to authenticated` in
-- 20260808000028_reporting_views.sql already covers v_review_queue by name --
-- CREATE OR REPLACE VIEW does not revoke existing grants, so no re-grant is
-- needed here.
