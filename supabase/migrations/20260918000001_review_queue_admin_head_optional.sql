-- Admin head becomes optional in Review's Classify stage (2026-09-18, user
-- request): a bill now counts as "finished"/"Reviewed" once its entry has
-- zone_id and sub_department_id set, regardless of admin_head_id. Previously
-- v_review_queue's WHERE clause (20260907000002, last touched by
-- 20260908000003_entry_bill_link_readers.sql's "v_review_queue: bill grain"
-- block) required all three columns, which kept a bill in the pending queue
-- forever if a reviewer deliberately left admin head unset.
--
-- review-workspace.tsx's stage3Done, app/(app)/documents/page.tsx's
-- classifiedEntryIds and app/(app)/review/page.tsx's REVIEWED_ONLY_OR /
-- sibling classifiedEntryIds filter drop the same admin_head_id check in the
-- same change -- this view's WHERE clause is the last piece that still
-- required it.
--
-- Base view body copied verbatim from the view's actual current definition,
-- 20260908000003_entry_bill_link_readers.sql's "v_review_queue: bill grain"
-- block -- only the WHERE clause's `e.admin_head_id is not null` conjunct is
-- removed. v_review_queue_all is untouched: it has no "finished" predicate of
-- its own (callers filter it, see app/(app)/review/page.tsx's
-- REVIEWED_ONLY_OR) and still exposes admin_head_id as a plain column, which
-- review-workspace.tsx still writes and displays as an optional field.
--
-- CREATE OR REPLACE VIEW keeps existing grants (20260814000009's note) -- no
-- re-grant needed.

create or replace view public.v_review_queue with (security_invoker = true) as
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
    sd.event_id
   from document_extraction de
     join source_document sd on sd.id = de.source_document_id
     left join ocr_extraction_run r on r.id = de.current_extraction_run_id
     left join v_bill_primary_entry bpe on bpe.document_extraction_id = de.id
     left join entries e on e.id = bpe.entry_id
     left join open_by_bill x on x.document_extraction_id = de.id
  where de.verified_at is null or not (sd.match_status = 'no_entry_expected'::text or bpe.entry_id is not null and e.zone_id is not null and e.sub_department_id is not null)
  order by (coalesce(x.rank, 0)) desc, r.extraction_confidence nulls first, (coalesce(e.amount, de.total_amount_ocr)) desc nulls last, de.id;
