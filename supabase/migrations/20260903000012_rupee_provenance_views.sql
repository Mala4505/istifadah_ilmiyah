-- reporting-blueprint.md §8 Phase Six / §3 E-05 -- Rupee provenance trace.
-- "Pick any rupee and follow it live: budget head -> allocation -> entry ->
--  the bill image -> the line item -> the item family -> the benchmark. This
--  is the demo that wins the meeting." §4 frames it as a live drill-down;
--  §6 fix #4 -- every figure is a link.
--
-- Two views back the E-05 section:
--
--   v_rupee_provenance_entry -- one row per NON-VOID entry. Doubles as (a) the
--     searchable index the picker lists candidates from (largest by amount)
--     and (b) the resolved head of the chain: every dimension id + label the
--     trace renders as a step, plus the bill scalars. One row in == one entry.
--
--   v_rupee_provenance_line -- one row per line item of an entry's bill, with
--     the item-family classification and the (family, unit, event) rate
--     benchmark attached where they resolve. Grain: one document_extraction_
--     line_item row. Family/benchmark columns are null on most of the corpus
--     today (item_family_id / item_catalog_id are backfilled by a separate
--     proposer pass -- 20260814000001's header) -- expected, handled null.
--
-- ----------------------------------------------------------------------------
-- Column-name resolution (grepped against the live schema, NOT guessed):
--
--  * "budget head"     -> entries.budget_head_id -> budget_head.raw_label
--                         (budget_head.short_label is the bracket/"AVIT" half).
--  * "allocation"      -> NOT a column on this view. The approved figure lives
--                         in budget_allocation (append-only snapshots, latest
--                         per (budget_head_id, event_id)) and is already
--                         surfaced by v_budget_vs_actual
--                         (20260822000007_reports_export_event_scoping.sql).
--                         The loader joins that view by budget_head_id +
--                         event_id rather than this view re-deriving the
--                         distinct-on-latest logic a second time.
--  * "budget category" -> the blueprint's "budget category" is the table that
--                         was literally named `budget_category` until
--                         20260813000004 renamed it to `cost_center` (Tally
--                         terminology, same table/data -- the bracket half of
--                         labels like "Dummas (AVIT)"). Resolved here via
--                         entries.cost_center_id -> cost_center.name and
--                         exposed as budget_category_id / budget_category_label
--                         to match the E-05 field list. Frequently null: it is
--                         a hub-enrichment field a reviewer sets, not an
--                         import-owned one.
--  * "the bill image"  -> source_document.storage_path in the
--                         'invoice-documents' bucket (lib/storage.ts /
--                         lib/actions/documents.ts getDocumentPreviewUrl).
--                         This view exposes source_document_id +
--                         has_bill_image; the section links the Bill step to
--                         the entry detail page (/entries/<id>), which already
--                         renders the PDF preview + BillViewModal -- a
--                         Server-Component section cannot mint a signed URL
--                         without importing the service-role signer and
--                         re-implementing the RLS pre-check that server action
--                         already does.
--  * line-item rates   -> 20260820000003_simplify_line_item_rate_fields.sql
--                         COLLAPSED the original list_rate/discount_pct/
--                         net_rate/line_amount split. Real columns now:
--                         rate_ocr/rate_verified (the single printed rate ==
--                         the net rate), amount_ocr/amount_verified,
--                         discount_ocr/discount_verified (FREE TEXT note like
--                         "10%+5%", not a number), hsn_sac_code_*, quantity_*,
--                         unit_*, unit_normalized, line_order. There is no
--                         list_rate, no numeric per-line discount_pct, and no
--                         per-line tax_amount on the line-item table. This
--                         view therefore exposes net_rate + line_amount +
--                         discount_note (text) from the line item, and picks
--                         up the NUMERIC discount_pct from rate_reference
--                         (populated only by the pre-20260820000003 verify
--                         bodies -- usually null) where a rate_reference row
--                         exists for the line.
--  * "the benchmark"   -> v_rate_benchmark (one row per (item_family_id,
--                         unit_normalized, event_id): median/min/max net_rate,
--                         observation_count, vendor_count). Joined on the
--                         line's rate_reference classification.
--
-- Entry -> document dedup: an entry can carry more than one source_document /
-- document_extraction (multi-bill PDFs, re-extraction). Both views use the
-- `distinct on (e.id)` pattern from 20260903000003_purchase_tree_view.sql's
-- entry_invoice CTE to pick ONE primary bill per entry (prefer a row that has
-- an extraction, then a verified extraction, then the newest) so the left
-- joins can't fan out the per-entry / per-line grain.
--
-- rate_reference dedup: verify_document_extraction inserts a rate_reference
-- row per line item per save and has no unique constraint on line_item_id, so
-- re-verifying a bill can leave two rows for one line. v_rupee_provenance_line
-- dedups rate_reference with `distinct on (line_item_id)` (newest id wins)
-- before joining, same anti-fan-out reasoning.
--
-- percentile_cont(...) (inside v_rate_benchmark.median_rate) returns double
-- precision; round(double precision, int) does not exist in Postgres (only
-- round(numeric, int)). Every derived ratio here is cast ::numeric before
-- round(), same fix as 20260903000002 / 20260903000004.
--
-- event_id is a plain output column on both views -- filtering happens at the
-- query site (20260822000011 convention), NOT inside the view. entries.event_id
-- can be null on legacy rows, so the loader scopes with
-- `.or('event_id.eq.<id>,event_id.is.null')` where relevant.
--
-- Department-leak note: entries is department-scoped by RLS
-- (private.can_see_department, 20260808000026); budget_head, vendor,
-- cost_center, admin_head, zone, document_extraction, document_extraction_
-- line_item, rate_reference, item_family, item_catalog are all staff-wide.
-- v_rupee_provenance_entry is FROM entries, so a department-scoped reviewer
-- simply does not see out-of-scope entries at all (row absent, not an error).
-- v_rupee_provenance_line is FROM document_extraction_line_item (staff-wide):
-- a scoped reviewer sees every line row, but entry_id / event_id / department_id
-- (resolved via the LEFT JOIN back to entries) read null for a line whose
-- entry sits outside their department -- the same leak-by-design property
-- v_rate_observation / v_purchase_tree already document, and acceptable here
-- because the line/family/benchmark comparison is the point.
--
-- security_invoker = true on both (every view in this codebase runs as the
-- calling user so base-table RLS applies). Both are brand-new objects the
-- historical blanket grant (20260808000026) and every later one predate, so
-- each needs its own explicit grant below.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- v_rupee_provenance_entry -- one row per non-void entry (picker index + chain head)
-- ----------------------------------------------------------------------------
create view public.v_rupee_provenance_entry with (security_invoker = true) as
with entry_doc as (
  select distinct on (e.id)
    e.id                       as entry_id,
    sd.id                      as source_document_id,
    de.id                      as document_extraction_id,
    de.total_amount_verified   as bill_total_verified,
    de.total_amount_ocr        as bill_total_ocr,
    de.invoice_number_verified as invoice_number_verified,
    de.invoice_number_ocr      as invoice_number_ocr,
    coalesce(de.instrument_type_verified, de.instrument_type_ocr) as instrument_type,
    de.verified_at             as bill_verified_at
  from public.entries e
  left join public.source_document sd on sd.entry_id = e.id
  left join public.document_extraction de
    on de.source_document_id = sd.id
   and coalesce(de.entry_id, sd.entry_id) = e.id
  order by
    e.id,
    (de.id is null),            -- prefer a source_document that has an extraction
    (de.verified_at is null),   -- prefer a verified extraction
    de.id desc                  -- then the newest
)
select
  e.id                                                            as entry_id,
  e.ubbl_number,
  e.amount                                                        as entry_amount,
  e.date                                                          as entry_date,
  e.type                                                          as entry_type,
  coalesce(e.invoice_number, ed.invoice_number_verified, ed.invoice_number_ocr) as invoice_number,
  e.department_id,
  d.name                                                          as department_name,
  e.sub_department_id,
  sub.name                                                        as sub_department_name,
  e.admin_head_id,
  ah.name                                                         as admin_head_name,
  e.vendor_id,
  v.display_name                                                  as vendor_display_name,
  e.budget_head_id,
  bh.raw_label                                                    as budget_head_label,
  bh.short_label                                                  as budget_head_short_label,
  e.cost_center_id                                                as budget_category_id,
  cc.name                                                         as budget_category_label,
  e.zone_id,
  z.name                                                          as zone_name,
  ed.source_document_id,
  ed.document_extraction_id,
  ed.instrument_type,
  ed.bill_total_verified,
  ed.bill_total_ocr,
  ed.bill_verified_at,
  (ed.source_document_id is not null)                             as has_bill_image,
  coalesce(li.line_item_count, 0)                                 as line_item_count,
  e.event_id
from public.entries e
left join entry_doc ed on ed.entry_id = e.id
left join public.department d on d.id = e.department_id
left join public.sub_department sub on sub.id = e.sub_department_id
left join public.admin_head ah on ah.id = e.admin_head_id
left join public.vendor v on v.id = e.vendor_id
left join public.budget_head bh on bh.id = e.budget_head_id
left join public.cost_center cc on cc.id = e.cost_center_id
left join public.zone z on z.id = e.zone_id
left join lateral (
  select count(*) as line_item_count
  from public.document_extraction_line_item dli
  where dli.document_extraction_id = ed.document_extraction_id
) li on true
where e.is_void = false;

grant select on public.v_rupee_provenance_entry to authenticated;

-- ----------------------------------------------------------------------------
-- v_rupee_provenance_line -- one row per line item of an entry's bill
-- ----------------------------------------------------------------------------
create view public.v_rupee_provenance_line with (security_invoker = true) as
with rr_dedup as (
  select distinct on (rr.line_item_id)
    rr.line_item_id,
    rr.id            as rate_reference_id,
    rr.net_rate      as rr_net_rate,
    rr.discount_pct  as rr_discount_pct,
    rr.item_family_id,
    rr.item_catalog_id,
    rr.unit_normalized as rr_unit_normalized
  from public.rate_reference rr
  where rr.line_item_id is not null
  order by rr.line_item_id, rr.id desc
)
select
  coalesce(de.entry_id, sd.entry_id)                              as entry_id,
  li.document_extraction_id,
  li.id                                                           as line_item_id,
  li.line_order                                                   as line_number,
  coalesce(li.description_verified, li.description_ocr)            as description,
  coalesce(li.hsn_sac_code_verified, li.hsn_sac_code_ocr)         as hsn_sac,
  coalesce(li.quantity_verified, li.quantity_ocr)                 as quantity,
  coalesce(li.unit_verified, li.unit_ocr)                         as unit,
  li.unit_normalized,
  coalesce(li.rate_verified, li.rate_ocr)                         as net_rate,
  coalesce(li.amount_verified, li.amount_ocr)                     as line_amount,
  coalesce(li.discount_verified, li.discount_ocr)                 as discount_note,
  rrd.rate_reference_id,
  rrd.rr_discount_pct                                             as discount_pct,
  rrd.item_family_id,
  fam.label                                                       as item_family_label,
  rrd.item_catalog_id,
  ic.canonical_label                                              as item_catalog_label,
  round(rb.median_rate::numeric, 2)                               as benchmark_median_rate,
  rb.observation_count                                            as benchmark_observation_count,
  rb.vendor_count                                                 as benchmark_vendor_count,
  case
    when rb.median_rate is not null
     and rb.median_rate <> 0
     and coalesce(rrd.rr_net_rate, li.rate_verified, li.rate_ocr) is not null
    -- percentile_cont (v_rate_benchmark.median_rate) is double precision, so
    -- the whole ratio is double; cast to numeric before round() -- Postgres
    -- has no round(double precision, int). Same fix as 20260903000002/04.
    then round(
      (((coalesce(rrd.rr_net_rate, li.rate_verified, li.rate_ocr) - rb.median_rate)
        / rb.median_rate) * 100)::numeric,
      2
    )
    else null
  end                                                            as rate_vs_benchmark_pct,
  e.department_id,
  e.event_id
from public.document_extraction_line_item li
join public.document_extraction de on de.id = li.document_extraction_id
left join public.source_document sd on sd.id = de.source_document_id
left join public.entries e on e.id = coalesce(de.entry_id, sd.entry_id)
left join rr_dedup rrd on rrd.line_item_id = li.id
left join public.item_family fam on fam.id = rrd.item_family_id
left join public.item_catalog ic on ic.id = rrd.item_catalog_id
left join public.v_rate_benchmark rb
  on rb.item_family_id = rrd.item_family_id
 and rb.unit_normalized is not distinct from coalesce(rrd.rr_unit_normalized, li.unit_normalized)
 and rb.event_id is not distinct from e.event_id;

grant select on public.v_rupee_provenance_line to authenticated;
