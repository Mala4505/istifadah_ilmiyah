-- Performance remediation plan (docs/performance-remediation-plan.md) Phase 1
-- -- root cause (A): v_review_queue / v_review_queue_all correlate a lateral
-- subquery per outer row, and Postgres cannot flatten a correlated `OR`
-- across two columns (ex.document_extraction_id = de.id
-- or ex.entry_id = coalesce(...)). It re-plans and re-executes the exception
-- scan once per document_extraction row on every /review load.
--
-- NOTE for whoever applies this: CREATE INDEX CONCURRENTLY cannot run inside
-- a transaction block. If your migration runner wraps the whole file in an
-- implicit BEGIN/COMMIT, split the CONCURRENTLY statements (1.1, 1.4, 1.5)
-- into their own file(s) applied outside a transaction, or drop CONCURRENTLY
-- for a one-off apply against a low-traffic window. Not verified against a
-- live plan -- review before applying (plan doc's own instruction).

-- ---------------------------------------------------------------------------
-- 1.1 -- status-scoped partial indexes on reconciliation_exception. The
-- existing recon_exception_extraction_idx / recon_exception_entry_idx
-- (20260808000023) are not scoped to open status, so every lookup returns
-- all historical rows for that key (open, resolved and dismissed alike)
-- before filtering status in a separate Filter node. Also serves
-- lib/jobs/handlers/extract.ts's dismiss-on-rerun update and
-- app/(app)/entries/[id]/page.tsx's per-entry exception lookup, both of
-- which currently fall back to the unscoped indexes.
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS recon_exception_open_extraction_idx
  ON public.reconciliation_exception (document_extraction_id)
  WHERE status = 'open' AND document_extraction_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS recon_exception_open_entry_idx
  ON public.reconciliation_exception (entry_id)
  WHERE status = 'open' AND entry_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 1.2 / 1.3 -- replace the per-row correlated lateral with a set-based CTE
-- on both views.
--
-- Semantic note (verified against live code, not assumed): the plan's own
-- draft warned that a plain "sum two independently-grouped CTEs" rewrite
-- would double-count a reconciliation_exception row that carries BOTH a
-- document_extraction_id and a matching entry_id. That shape is real --
-- lib/actions/review.ts's flagReviewException (§7 "flag as exception") in
-- `E`, the review workspace) inserts a row with entry_id AND
-- document_extraction_id set together whenever the flagged bill is already
-- attached to an entry. So this rewrite matches each open exception to the
-- set of document_extraction rows it applies to (by direct id, or by
-- resolved entry id) as a single UNION'd (id, document_extraction_id) pair
-- list -- UNION, not UNION ALL, collapses the case where the same exception
-- matches the same bill via both conditions at once, back down to one row --
-- exactly the old lateral's per-row `OR` semantics, computed as a join
-- instead of N per-row subplans.
-- ---------------------------------------------------------------------------
create or replace view public.v_review_queue with (security_invoker = true) as
with ex_matched_by_extraction as (
  select ex.id as ex_id, de.id as document_extraction_id, ex.severity
  from public.reconciliation_exception ex
  join public.document_extraction de on de.id = ex.document_extraction_id
  where ex.status = 'open'
),
ex_matched_by_entry as (
  -- v_review_queue resolves a bill's entry as coalesce(de.entry_id,
  -- sd.entry_id) everywhere else (20260821000002_entry_id_coalesce_fix.sql)
  -- -- mirrored here so a per-bill match (document_extraction.entry_id) is
  -- found, not just a whole-document match (source_document.entry_id).
  -- Split into two plain equi-joins (rather than one join on a coalesce
  -- expression, which both can't use document_extraction_entry_idx /
  -- source_document_entry_idx and can't reference `sd` before it's
  -- introduced in a single JOIN..ON) and UNION'd -- disjoint by construction
  -- (the second branch only matches rows the first didn't, via
  -- `de.entry_id is null`), so this union needs no separate dedup from the
  -- one wrapping ex_matched_by_extraction/ex_matched_by_entry below.
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
order by
  max_open_severity_rank desc,
  r.extraction_confidence asc nulls first,
  queue_amount desc nulls last,
  de.id asc;

-- CREATE OR REPLACE VIEW does not revoke existing grants (20260814000009's
-- note) -- no re-grant needed here.

-- ---------------------------------------------------------------------------
-- v_review_queue_all -- same CTE rewrite. Deliberately NOT aligned to
-- v_review_queue's coalesce(de.entry_id, sd.entry_id) entry resolution: this
-- view's `entries e on e.id = sd.entry_id` join and its lateral already only
-- ever used sd.entry_id (pre-existing since 20260821000006, and NOT touched
-- by 20260821000002's coalesce fix, which only patched v_review_queue). That
-- looks like a real gap -- a per-bill match on document_extraction.entry_id
-- goes unrecognised by the "All documents" toggle -- but fixing it is a
-- behaviour change outside this rewrite's scope (root cause A is the lateral
-- itself, not entry resolution). Flagged here for the next pass; preserved
-- as-is below.
--
-- Bound added per 1.3: no WHERE clause here previously meant this view's
-- cost scaled with total extraction history rather than pending work.
-- Rolling 2-year window on de.created_at, confirmed with the user.
-- ---------------------------------------------------------------------------
create or replace view public.v_review_queue_all with (security_invoker = true) as
with ex_matched_by_extraction as (
  select ex.id as ex_id, de.id as document_extraction_id, ex.severity
  from public.reconciliation_exception ex
  join public.document_extraction de on de.id = ex.document_extraction_id
  where ex.status = 'open'
),
ex_matched_by_entry as (
  select ex.id as ex_id, de.id as document_extraction_id, ex.severity
  from public.reconciliation_exception ex
  join public.source_document sd on sd.entry_id = ex.entry_id
  join public.document_extraction de on de.source_document_id = sd.id
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
  sd.entry_id,
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
  de.verified_at,
  sd.event_id
from public.document_extraction de
join public.source_document sd on sd.id = de.source_document_id
left join public.ocr_extraction_run r on r.id = de.current_extraction_run_id
left join public.entries e on e.id = sd.entry_id
left join open_by_bill x on x.document_extraction_id = de.id
where de.created_at > now() - interval '2 years'
order by
  max_open_severity_rank desc,
  r.extraction_confidence asc nulls first,
  queue_amount desc nulls last,
  de.id asc;

-- Explicit grant restated -- harmless no-op if it already exists, but keeps
-- this migration self-contained per 20260821000006's own note.
grant select on public.v_review_queue_all to authenticated;

-- ---------------------------------------------------------------------------
-- 1.4 -- stop counting through the view. app/(app)/review/page.tsx's
-- queueCountQuery ran `select('*', { count: 'exact', head: true })` against
-- the view -- Postgres cannot prove the (now former) correlated lateral is
-- row-count-preserving, so count(*) re-ran the most expensive half of the
-- list query just to answer "how many are pending". The application code
-- change (counting document_extraction directly, joined to source_document
-- only for the event filter) is in app/(app)/review/page.tsx; this index
-- supports that new query's plan for the 'pending' (unverified) scope.
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_extraction_unverified_idx
  ON public.document_extraction (source_document_id)
  WHERE verified_at IS NULL;

-- ---------------------------------------------------------------------------
-- 1.5 -- four remaining supporting indexes.
-- ---------------------------------------------------------------------------

-- Removes a sort step from a query issued on every review-page load.
CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_line_item_parent_order_idx
  ON public.document_extraction_line_item (document_extraction_id, line_order);

-- entries_date_idx has no is_void predicate, so the scan increasingly walks
-- past voided rows as they accumulate.
CREATE INDEX CONCURRENTLY IF NOT EXISTS entries_active_date_idx
  ON public.entries (date DESC)
  WHERE is_void = false;

-- source_document_inbox_idx covers only 'unmatched'/'suggested'.
CREATE INDEX CONCURRENTLY IF NOT EXISTS source_document_matched_idx
  ON public.source_document (match_status)
  WHERE match_status = 'matched';

-- v_vendor_shared_identity_edges' case-insensitive address self-join
-- recomputes lower(trim(...)) per row with no functional index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS vendor_address_normalized_idx
  ON public.vendor (lower(trim(address)))
  WHERE address IS NOT NULL;
