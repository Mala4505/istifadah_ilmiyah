-- D1 fix (docs/import-review-ux-plan.md §1, checklist Phase 1 D1): every
-- reader below joined/counted entries via `source_document.entry_id` alone.
-- That column is only the single-bill convenience mirror written by
-- lib/jobs/handlers/extract.ts; a per-bill match written by
-- attachExtractionToEntry (lib/actions/review.ts) lands on
-- `document_extraction.entry_id` and was never read anywhere. Net effect:
-- attaching bill 2 of a multi-bill PDF to an entry succeeded, but the
-- review combobox, TallyFooter, the Hub status button, and these reporting
-- views all kept behaving as if nothing was attached.
--
-- Fix, applied consistently: treat `document_extraction.entry_id` as the
-- source of truth for a bill's match, falling back to
-- `source_document.entry_id` with `coalesce(de.entry_id, sd.entry_id)` --
-- exactly what `app/(app)/review/page.tsx`'s `entryId` derivation now does
-- in application code (task 1.2/1.3 of the same pass).
--
-- All three views keep their existing column lists, so `create or replace
-- view` is used throughout; per 20260814000009's note, that does not revoke
-- existing grants, so no re-grant is needed.

-- ----------------------------------------------------------------------------
-- v_review_queue -- base definition: 20260817000004_review_queue_multi_bill.sql.
-- Only change: the `entry_id` output column, the `entries` join, and the
-- open-reconciliation-exception lateral now resolve entry_id via
-- coalesce(de.entry_id, sd.entry_id) instead of sd.entry_id alone. This also
-- fixes `queue_amount` (coalesce(e.amount, de.total_amount_ocr)) for a
-- per-bill-matched multi-bill document, which previously fell back to the
-- OCR total because the `entries` join missed it entirely.
-- ----------------------------------------------------------------------------
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
  count(*) over (partition by de.source_document_id) as bill_count
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

-- ----------------------------------------------------------------------------
-- v_entry_enriched -- base definition: 20260813000004_cost_center_rename.sql
-- (the last migration-tracked definition; only the `document_count` join
-- changes, cost_center columns untouched). A document previously counted
-- only when `source_document.entry_id` mirrored it; now also counts when any
-- of its bills (`document_extraction.entry_id`) matched this entry, still
-- deduplicated to one count per `source_document` (a document with two bills
-- matched to the same entry still counts once, matching prior semantics of
-- "documents attached to this entry", not "bills attached").
-- ----------------------------------------------------------------------------
create or replace view public.v_entry_enriched with (security_invoker = true) as
select
  e.id,
  e.type,
  e.ubbl_number,
  e.main_number,
  e.department_id,
  d.name as department_name,
  e.budget_head_id,
  bh.raw_label as budget_head_raw_label,
  bh.short_label as budget_head_short_label,
  e.invoice_number,
  e.vendor_id,
  v.display_name as vendor_display_name,
  e.vendor_raw,
  e.date,
  e.amount,
  e.variance_reason,
  e.status_id,
  st.code as status_code,
  st.label as status_label,
  e.audit_status_id,
  ast.code as audit_status_code,
  ast.label as audit_status_label,
  e.status_raw,
  e.audit_status_raw,
  e.admin_head_id,
  ah.name as admin_head_name,
  e.zone_id,
  z.name as zone_name,
  e.cost_center_id,
  cc.name as cost_center_name,
  e.remark,
  -- hub_status_* columns unchanged/deferred, see 20260811000003's header
  e.hub_status_id,
  hs.code as hub_status_code,
  hs.label as hub_status_label,
  e.hub_status_changed_at,
  e.hub_status_changed_by,
  e.hub_status_note,
  e.hub_status_exported_at,
  e.audit_status_changed_at,
  e.audit_status_changed_by,
  e.settles_entry_id,
  e.is_void,
  e.source,
  e.import_batch_id,
  e.created_at,
  e.updated_at,
  coalesce(doc.document_count, 0) as document_count
from public.entries e
left join public.department d on d.id = e.department_id
left join public.budget_head bh on bh.id = e.budget_head_id
left join public.vendor v on v.id = e.vendor_id
left join public.entry_status st on st.id = e.status_id
left join public.entry_status ast on ast.id = e.audit_status_id
left join public.admin_head ah on ah.id = e.admin_head_id
left join public.zone z on z.id = e.zone_id
left join public.cost_center cc on cc.id = e.cost_center_id
left join public.hub_status hs on hs.id = e.hub_status_id
left join (
  select coalesce(de.entry_id, sd.entry_id) as entry_id, count(distinct sd.id) as document_count
  from public.source_document sd
  left join public.document_extraction de
    on de.source_document_id = sd.id
   and de.entry_id is not null
  where coalesce(de.entry_id, sd.entry_id) is not null
  group by coalesce(de.entry_id, sd.entry_id)
) doc on doc.entry_id = e.id;

-- ----------------------------------------------------------------------------
-- v_vendor_spend -- base definition: 20260811000004_reporting_views_update.sql
-- (the last migration-tracked definition; unchanged elsewhere). The original
-- `left join source_document sd on sd.entry_id = e.id` both missed per-bill
-- matches AND fanned out `sum(e.amount)`/`count(e.id)` whenever an entry had
-- more than one attached document (each extra document row re-summed the
-- entry's amount). Replaced with a pre-deduplicated `entry_docs` CTE, joined
-- by entry id, so the join contributes at most one row per entry -- fixing
-- both the coalesce gap and the pre-existing fanout in the same change,
-- since leaving the fanout in place while adding document_extraction rows
-- would only have made it worse.
-- ----------------------------------------------------------------------------
create or replace view public.v_vendor_spend with (security_invoker = true) as
with entry_docs as (
  select distinct coalesce(de.entry_id, sd.entry_id) as entry_id
  from public.source_document sd
  left join public.document_extraction de
    on de.source_document_id = sd.id
   and de.entry_id is not null
  where coalesce(de.entry_id, sd.entry_id) is not null
)
select
  v.id as vendor_id,
  v.display_name,
  v.normalized_name,
  v.is_confirmed,
  count(e.id) as entry_count,
  sum(e.amount) as total_amount,
  min(e.date) as first_entry_date,
  max(e.date) as last_entry_date,
  count(distinct ed.entry_id) as entries_with_documents,
  case when count(e.id) = 0 then null
       else round(count(distinct ed.entry_id)::numeric / count(e.id) * 100, 2)
  end as document_coverage_pct
from public.vendor v
left join public.entries e on e.vendor_id = v.id and e.is_void = false
left join entry_docs ed on ed.entry_id = e.id
group by v.id, v.display_name, v.normalized_name, v.is_confirmed;
