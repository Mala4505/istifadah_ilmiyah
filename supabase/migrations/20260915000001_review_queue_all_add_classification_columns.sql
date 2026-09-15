-- Reviewed/Needs work/All queue toggle (2026-09-15): the /review queue's
-- scope toggle only ever had two states -- v_review_queue ("Needs work",
-- unfinished bills) and v_review_queue_all ("All", every bill). There was no
-- way to see *only* the bills a reviewer has already finished, which is what
-- made a just-saved bill hard to find again once handleSave (review-
-- workspace.tsx) stopped auto-navigating away from it (see that file's
-- 2026-09-15 comment) -- the reviewer's only path back to it was scrolling
-- "All" by hand.
--
-- app/(app)/review/page.tsx's new "Reviewed" scope filters v_review_queue_all
-- rows using the same three-stage "done" predicate v_review_queue's own WHERE
-- clause already encodes (verified_at set AND (no_entry_expected OR the
-- bill's primary linked entry has admin_head_id/zone_id/sub_department_id all
-- set) -- same definition components/documents/document-card.tsx's
-- "Reviewed" badge uses). v_review_queue_all's SELECT doesn't expose the
-- three classification columns needed to filter on that, so this adds them,
-- verbatim from the `entries e` join the view already has (no join/filter
-- change, no behaviour change to any existing column -- pure column
-- addition, which CREATE OR REPLACE VIEW allows appended at the end of the
-- SELECT list).
--
-- Base view body copied verbatim from the view's actual current definition,
-- 20260908000003_entry_bill_link_readers.sql (its "v_review_queue_all: same
-- swap" block) -- NOT from the older 20260904000001_review_queue_perf_rewrite.sql
-- copy that an earlier draft of this migration was mistakenly based on: that
-- draft referenced sd.entry_id, which 20260908000004_drop_entry_id_mirrors.sql
-- already dropped, and failed to apply (SQLSTATE 42703) against the real
-- remote schema. 20260908000003 replaced the sd.entry_id join with
-- v_bill_primary_entry (one row per bill, entry_bill_link-backed) -- that's
-- the join this migration extends.

create or replace view public.v_review_queue_all with (security_invoker = true) as
 with ex_matched_by_extraction as (
         select ex.id as ex_id,
            de_1.id as document_extraction_id,
            ex.severity
           from reconciliation_exception ex
             join document_extraction de_1 on de_1.id = ex.document_extraction_id
          where ex.status = 'open'::text
        ), ex_matched_by_entry as (
         select ex.id as ex_id,
            l.document_extraction_id,
            ex.severity
           from reconciliation_exception ex
             join entry_bill_link l on l.entry_id = ex.entry_id and l.document_extraction_id is not null
          where ex.status = 'open'::text and ex.entry_id is not null
        ), open_by_bill as (
         select matched.document_extraction_id,
            count(*) as open_count,
            max(
                case matched.severity
                    when 'high'::text then 3
                    when 'medium'::text then 2
                    when 'low'::text then 1
                    else 0
                end) as rank
           from ( select ex_matched_by_extraction.ex_id,
                    ex_matched_by_extraction.document_extraction_id,
                    ex_matched_by_extraction.severity
                   from ex_matched_by_extraction
                union
                 select ex_matched_by_entry.ex_id,
                    ex_matched_by_entry.document_extraction_id,
                    ex_matched_by_entry.severity
                   from ex_matched_by_entry) matched
          group by matched.document_extraction_id
        )
 select de.id as document_extraction_id,
    de.source_document_id,
    bpe.entry_id,
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
    sd.event_id,
    e.admin_head_id,
    e.zone_id,
    e.sub_department_id
   from document_extraction de
     join source_document sd on sd.id = de.source_document_id
     left join ocr_extraction_run r on r.id = de.current_extraction_run_id
     left join v_bill_primary_entry bpe on bpe.document_extraction_id = de.id
     left join entries e on e.id = bpe.entry_id
     left join open_by_bill x on x.document_extraction_id = de.id
  where de.created_at > (now() - '2 years'::interval)
  order by (coalesce(x.rank, 0)) desc, r.extraction_confidence nulls first, (coalesce(e.amount, de.total_amount_ocr)) desc nulls last, de.id;

-- CREATE OR REPLACE VIEW keeps existing grants (20260814000009's note) -- no
-- re-grant needed.
