-- Entries <-> Bills many-to-many, Phase 4 (plan: entry-bill links with
-- automatic variance).
--
-- The reader rewrite. Every SQL object that still reads the scalar
-- document_extraction.entry_id / source_document.entry_id is moved onto
-- entry_bill_link (directly, or via v_bill_primary_entry / the variance views
-- from Phase 2). After this migration the scalar columns have NO SQL readers
-- left -- Phase 6 (20260908000004, still parked) drops them and the temporary
-- junction->scalar mirror trigger.
--
-- Ordering here follows the plan's risk order: plain reporting views first,
-- then v_entry_enriched, then the review queues, then the SECURITY DEFINER
-- functions, and private.can_see_source_document DEAD LAST -- a mistake in the
-- RLS gate hides documents silently rather than erroring.
--
-- Column lists are preserved EXACTLY on every `create or replace view` so the
-- ~25 downstream views and the TS loaders that read these all compile
-- unchanged. Cardinality is preserved too: an entry->bill or bill->entry swap
-- that could fan a row out (and multiply a rupee column) goes through
-- v_bill_primary_entry (one entry per bill) rather than a bare junction join.
--
-- >>> THE DOUBLE-COUNTING RULE (Phase 2 header) still applies: never sum a
--     per-row-honest rupee column across rows once a bill/entry is shared.
--     None of the rewrites below introduce such a sum -- they all preserve the
--     pre-junction cardinality.

-- ===========================================================================
-- match_status becomes trigger-derived
-- ===========================================================================
-- Until now source_document.match_status was written by the app
-- (attachDocumentToEntry, the ingest route, ...). With one bill able to cover
-- several entries -- and a multi-bill PDF only half-connected -- "matched" has
-- to mean EVERY bill of the document is linked, not "at least one". That is not
-- something the app can keep coherent from the outside, so it moves to a
-- trigger on entry_bill_link + document_extraction.
--
-- Rules:
--   * 'no_entry_expected' / 'canceled' are human-set. They stay sticky UNLESS
--     the document becomes fully linked (a deliberate attach overrides a park),
--     in which case they flip to 'matched'.
--   * 0 bills + >=1 (placeholder) link            => 'matched' (attached pre-extraction)
--   * >=1 bill, every bill has >=1 link           => 'matched'
--   * anything else                               => 'unmatched'
--   * 'suggested' is never produced here (it has no writer anywhere) -- the
--     CHECK constraint keeps the value legal, that's all.
create or replace function private.recompute_source_document_match_status(p_source_document_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_current text;
  v_bill_count int;
  v_link_count int;
  v_unlinked_bill_count int;
  v_target text;
begin
  if p_source_document_id is null then return; end if;

  select match_status into v_current
  from public.source_document where id = p_source_document_id;
  if v_current is null then return; end if;   -- document gone

  select count(*) into v_bill_count
  from public.document_extraction where source_document_id = p_source_document_id;

  select count(*) into v_link_count
  from public.entry_bill_link where source_document_id = p_source_document_id;

  if v_bill_count = 0 then
    v_target := case when v_link_count > 0 then 'matched' else 'unmatched' end;
  else
    select count(*) into v_unlinked_bill_count
    from public.document_extraction de
    where de.source_document_id = p_source_document_id
      and not exists (
        select 1 from public.entry_bill_link l where l.document_extraction_id = de.id
      );
    v_target := case when v_unlinked_bill_count = 0 then 'matched' else 'unmatched' end;
  end if;

  -- Sticky human states: only a full attach (=> 'matched') overrides them.
  if v_current in ('no_entry_expected', 'canceled') and v_target <> 'matched' then
    return;
  end if;

  if v_current is distinct from v_target then
    update public.source_document
      set match_status = v_target
      where id = p_source_document_id;
  end if;
end;
$$;

comment on function private.recompute_source_document_match_status(bigint) is
  'Derives source_document.match_status from entry_bill_link + document_extraction. matched = every bill linked (or a pre-extraction placeholder link on a bill-less doc). no_entry_expected / canceled are sticky unless the doc becomes fully linked. Feature: entry-bill links, 2026-09-08.';

create or replace function private.sync_source_document_match_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'entry_bill_link' then
    perform private.recompute_source_document_match_status(
      coalesce(new.source_document_id, old.source_document_id));
  else  -- document_extraction
    perform private.recompute_source_document_match_status(
      coalesce(new.source_document_id, old.source_document_id));
  end if;
  return null;
end;
$$;

create trigger entry_bill_link_match_status
  after insert or delete on public.entry_bill_link
  for each row execute function private.sync_source_document_match_status();

create trigger document_extraction_match_status
  after insert or delete on public.document_extraction
  for each row execute function private.sync_source_document_match_status();

-- ===========================================================================
-- 1. Plain reporting views -- entry-grain "does this entry have a document"
-- ===========================================================================

-- v_admin_head_spend: sd.entry_id -> entry_bill_link.entry_id
create or replace view public.v_admin_head_spend with (security_invoker = true) as
  select ah.id as admin_head_id,
    ah.name as admin_head_name,
    ah.department_id,
    d.name as department_name,
    e.event_id,
    count(e.id) as entry_count,
    coalesce(sum(e.amount), 0::numeric) as total_amount,
    count(distinct ebl.entry_id) as entries_with_documents,
        case
            when count(e.id) = 0 then null::numeric
            else round(count(distinct ebl.entry_id)::numeric / count(e.id)::numeric * 100::numeric, 2)
        end as document_coverage_pct
   from admin_head ah
     join department d on d.id = ah.department_id
     left join entries e on e.admin_head_id = ah.id and e.is_void = false
     left join entry_bill_link ebl on ebl.entry_id = e.id
  group by ah.id, ah.name, ah.department_id, d.name, e.event_id;

-- v_department_documentation_coverage: same swap
create or replace view public.v_department_documentation_coverage with (security_invoker = true) as
  select e.department_id,
    d.name as department_name,
    e.event_id,
    count(e.id) as entry_count,
    count(distinct ebl.entry_id) as entries_with_documents,
    round(count(distinct ebl.entry_id)::numeric / count(e.id)::numeric * 100::numeric, 2) as document_coverage_pct
   from entries e
     join department d on d.id = e.department_id
     left join entry_bill_link ebl on ebl.entry_id = e.id
  where e.is_void = false and e.department_id is not null
  group by e.department_id, d.name, e.event_id;

-- v_entries_without_bill: "no linked VERIFIED bill". has_document = any link.
create or replace view public.v_entries_without_bill with (security_invoker = true) as
 with entry_doc as (
         select e.id as entry_id,
            e.department_id,
            e.vendor_id,
            e.amount as entry_amount,
            e.date as entry_date,
            e.event_id,
            exists (select 1 from entry_bill_link l where l.entry_id = e.id) as has_document,
            exists (
              select 1 from entry_bill_link l
              join document_extraction de on de.id = l.document_extraction_id
              where l.entry_id = e.id and de.total_amount_verified is not null
            ) as has_verified_bill
           from entries e
          where e.is_void = false
        )
 select ed.entry_id,
    ed.department_id,
    d.name as department_name,
    ed.vendor_id,
    v.display_name as vendor_display_name,
    ed.entry_amount,
    ed.entry_date,
    ed.has_document,
    ed.event_id
   from entry_doc ed
     left join department d on d.id = ed.department_id
     left join vendor v on v.id = ed.vendor_id
  where ed.has_verified_bill = false;

-- v_entries_without_bill_rollup: same base, unchanged rollup shape
create or replace view public.v_entries_without_bill_rollup with (security_invoker = true) as
 with base as (
         select e.id as entry_id,
            e.department_id,
            e.vendor_id,
            e.amount as entry_amount,
            e.event_id,
            exists (select 1 from entry_bill_link l where l.entry_id = e.id) as has_document,
            exists (
              select 1 from entry_bill_link l
              join document_extraction de on de.id = l.document_extraction_id
              where l.entry_id = e.id and de.total_amount_verified is not null
            ) as has_verified_bill
           from entries e
          where e.is_void = false
        ), undocumented as (
         select base.entry_id,
            base.department_id,
            base.vendor_id,
            base.entry_amount,
            base.event_id,
            base.has_document
           from base
          where base.has_verified_bill = false
        )
 select 'department'::text as dimension,
    u.department_id as dimension_id,
    d.name as dimension_name,
    u.event_id,
    count(*) as entry_count,
    count(*) filter (where not u.has_document) as no_document_count,
    coalesce(sum(u.entry_amount), 0::numeric) as undocumented_amount
   from undocumented u
     left join department d on d.id = u.department_id
  group by u.department_id, d.name, u.event_id
union all
 select 'vendor'::text as dimension,
    u.vendor_id as dimension_id,
    v.display_name as dimension_name,
    u.event_id,
    count(*) as entry_count,
    count(*) filter (where not u.has_document) as no_document_count,
    coalesce(sum(u.entry_amount), 0::numeric) as undocumented_amount
   from undocumented u
     left join vendor v on v.id = u.vendor_id
  group by u.vendor_id, v.display_name, u.event_id;

-- ===========================================================================
-- 2. v_entry_enriched.document_count -> grouped subquery on the junction
-- ===========================================================================
-- security_invoker = true is RE-ASSERTED here: 20260828000001 recreated this
-- view with a bare `create view ... as` and silently dropped the flag (a
-- `create or replace view` without a WITH clause resets reloptions), so the
-- view has been running with the owner's rights -- i.e. leaking entries across
-- departments -- since 2026-08-28. 20260908000005 fixes the sibling views the
-- same regression hit.
create or replace view public.v_entry_enriched with (security_invoker = true) as
 select e.id,
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
    e.status_id,
    st.code as status_code,
    st.label as status_label,
    e.status_raw,
    e.admin_head_id,
    ah.name as admin_head_name,
    e.zone_id,
    z.name as zone_name,
    e.cost_center_id,
    cc.name as cost_center_name,
    e.remark,
    e.hub_status_id,
    hs.code as hub_status_code,
    hs.label as hub_status_label,
    e.hub_status_changed_at,
    e.hub_status_changed_by,
    e.hub_status_note,
    e.hub_status_exported_at,
    e.audit_synced_at,
    e.audit_sync_batch_id,
    e.settles_entry_id,
    e.is_void,
    e.source,
    e.import_batch_id,
    e.created_at,
    e.updated_at,
    coalesce(doc.document_count, 0::bigint) as document_count,
    e.event_id,
    e.sub_department_id,
    sub.name as sub_department_name,
    rd.sr_no as reimbursement_sr_no,
    rd.reimbursement_type,
    rd.reimburse_to_raw,
    apd.invoice_amount as advance_invoice_amount
   from entries e
     left join department d on d.id = e.department_id
     left join budget_head bh on bh.id = e.budget_head_id
     left join vendor v on v.id = e.vendor_id
     left join entry_status st on st.id = e.status_id
     left join admin_head ah on ah.id = e.admin_head_id
     left join zone z on z.id = e.zone_id
     left join cost_center cc on cc.id = e.cost_center_id
     left join hub_status hs on hs.id = e.hub_status_id
     left join ( select l.entry_id,
            count(distinct l.source_document_id) as document_count
           from entry_bill_link l
          group by l.entry_id) doc on doc.entry_id = e.id
     left join sub_department sub on sub.id = e.sub_department_id
     left join reimbursement_detail rd on rd.entry_id = e.id
     left join advance_payment_detail apd on apd.entry_id = e.id;

-- ===========================================================================
-- 3. Entry-grain views that pick ONE bill per entry (DISTINCT ON kept)
-- ===========================================================================

-- v_instrument_type_mix
create or replace view public.v_instrument_type_mix with (security_invoker = true) as
 with entry_instrument as (
         select distinct on (e.id) e.id as entry_id,
            e.department_id,
            e.event_id,
            e.amount,
            coalesce(de.instrument_type_verified, de.instrument_type_ocr) as instrument_type,
            de.id is not null as has_extraction
           from entries e
             left join entry_bill_link l on l.entry_id = e.id
             left join document_extraction de on de.id = l.document_extraction_id
          where e.is_void = false
          order by e.id, (coalesce(de.instrument_type_verified, de.instrument_type_ocr) is null), (de.verified_at is null), de.id desc
        )
 select ei.department_id,
    d.name as department_name,
    ei.event_id,
    coalesce(ei.instrument_type,
        case
            when ei.has_extraction then 'unclassified'::text
            else 'no_document'::text
        end) as instrument_type,
    count(*) as entry_count,
    coalesce(sum(ei.amount), 0::numeric) as total_amount
   from entry_instrument ei
     left join department d on d.id = ei.department_id
  group by ei.department_id, d.name, ei.event_id, (coalesce(ei.instrument_type,
        case
            when ei.has_extraction then 'unclassified'::text
            else 'no_document'::text
        end));

-- v_purchase_tree
create or replace view public.v_purchase_tree with (security_invoker = true) as
 with entry_invoice as (
         select distinct on (e_1.id) e_1.id as entry_id,
            coalesce(e_1.invoice_number, de.invoice_number_verified, de.invoice_number_ocr) as invoice_number
           from entries e_1
             left join entry_bill_link l on l.entry_id = e_1.id
             left join document_extraction de on de.id = l.document_extraction_id
          order by e_1.id, (coalesce(e_1.invoice_number, de.invoice_number_verified, de.invoice_number_ocr) is null), (de.verified_at is null), de.id desc
        )
 select rr.item_family_id,
    fam.family_key,
    fam.label as family_label,
    rr.item_catalog_id,
    ic.canonical_label as catalog_label,
    rr.vendor_id,
    v.display_name as vendor_display_name,
    rr.entry_id,
    ei.invoice_number,
    rr.net_rate,
    coalesce(rr.quantity, 1::numeric) as quantity,
    round(rr.net_rate * coalesce(rr.quantity, 1::numeric), 2) as line_amount,
    rr.observed_date,
    e.department_id,
    d.name as department_name,
    e.event_id
   from rate_reference rr
     join item_family fam on fam.id = rr.item_family_id
     left join item_catalog ic on ic.id = rr.item_catalog_id
     left join vendor v on v.id = rr.vendor_id
     left join entries e on e.id = rr.entry_id
     left join department d on d.id = e.department_id
     left join entry_invoice ei on ei.entry_id = rr.entry_id
  where rr.item_family_id is not null;

-- v_rupee_provenance_entry
create or replace view public.v_rupee_provenance_entry with (security_invoker = true) as
 with entry_doc as (
         select distinct on (e_1.id) e_1.id as entry_id,
            l.source_document_id as source_document_id,
            de.id as document_extraction_id,
            de.total_amount_verified as bill_total_verified,
            de.total_amount_ocr as bill_total_ocr,
            de.invoice_number_verified,
            de.invoice_number_ocr,
            coalesce(de.instrument_type_verified, de.instrument_type_ocr) as instrument_type,
            de.verified_at as bill_verified_at
           from entries e_1
             left join entry_bill_link l on l.entry_id = e_1.id
             left join document_extraction de on de.id = l.document_extraction_id
          order by e_1.id, (de.id is null), (de.verified_at is null), de.id desc
        )
 select e.id as entry_id,
    e.ubbl_number,
    e.amount as entry_amount,
    e.date as entry_date,
    e.type as entry_type,
    coalesce(e.invoice_number, ed.invoice_number_verified, ed.invoice_number_ocr) as invoice_number,
    e.department_id,
    d.name as department_name,
    e.sub_department_id,
    sub.name as sub_department_name,
    e.admin_head_id,
    ah.name as admin_head_name,
    e.vendor_id,
    v.display_name as vendor_display_name,
    e.budget_head_id,
    bh.raw_label as budget_head_label,
    bh.short_label as budget_head_short_label,
    e.cost_center_id as budget_category_id,
    cc.name as budget_category_label,
    e.zone_id,
    z.name as zone_name,
    ed.source_document_id,
    ed.document_extraction_id,
    ed.instrument_type,
    ed.bill_total_verified,
    ed.bill_total_ocr,
    ed.bill_verified_at,
    ed.source_document_id is not null as has_bill_image,
    coalesce(li.line_item_count, 0::bigint) as line_item_count,
    e.event_id
   from entries e
     left join entry_doc ed on ed.entry_id = e.id
     left join department d on d.id = e.department_id
     left join sub_department sub on sub.id = e.sub_department_id
     left join admin_head ah on ah.id = e.admin_head_id
     left join vendor v on v.id = e.vendor_id
     left join budget_head bh on bh.id = e.budget_head_id
     left join cost_center cc on cc.id = e.cost_center_id
     left join zone z on z.id = e.zone_id
     left join lateral ( select count(*) as line_item_count
           from document_extraction_line_item dli
          where dli.document_extraction_id = ed.document_extraction_id) li on true
  where e.is_void = false;

-- ===========================================================================
-- 4. Bill-grain views -> v_bill_primary_entry (cardinality preserver)
-- ===========================================================================

-- v_hsn_gst_anomaly
create or replace view public.v_hsn_gst_anomaly with (security_invoker = true) as
 with line_norm as (
         select li.document_extraction_id,
            nullif(regexp_replace(coalesce(li.hsn_sac_code_verified, li.hsn_sac_code_ocr), '\D'::text, ''::text, 'g'::text), ''::text) as hsn_digits
           from document_extraction_line_item li
        ), line_rate as (
         select ln.document_extraction_id,
            ln.hsn_digits,
            m.implied_rate
           from line_norm ln
             left join lateral ( select hgr.gst_rate as implied_rate
                   from hsn_gst_rate hgr
                  where ln.hsn_digits is not null and "left"(ln.hsn_digits, length(hgr.code)) = hgr.code
                  order by (length(hgr.code)) desc
                 limit 1) m on true
        ), line_agg as (
         select line_rate.document_extraction_id,
            count(*) as line_count,
            count(line_rate.hsn_digits) as lines_with_hsn,
            count(line_rate.implied_rate) as lines_matched,
            avg(line_rate.implied_rate) as implied_rate_avg
           from line_rate
          group by line_rate.document_extraction_id
        ), bill as (
         select de.id as bill_id,
            bpe.entry_id,
            la.line_count,
            la.lines_with_hsn,
            la.lines_matched,
            round(la.lines_with_hsn::numeric / nullif(la.line_count, 0)::numeric * 100::numeric, 2) as hsn_coverage_pct,
            round(coalesce(de.subtotal_verified, de.subtotal_ocr)::numeric, 2) as taxable_value,
            round(coalesce(de.tax_amount_verified, de.tax_amount_ocr)::numeric, 2) as tax_amount,
            round(coalesce(de.total_amount_verified, de.total_amount_ocr)::numeric, 2) as bill_total,
                case
                    when la.lines_matched > 0 then round(la.implied_rate_avg, 2)
                    else null::numeric
                end as implied_gst_rate,
                case
                    when coalesce(de.subtotal_verified, de.subtotal_ocr) is not null and coalesce(de.subtotal_verified, de.subtotal_ocr) <> 0::numeric and coalesce(de.tax_amount_verified, de.tax_amount_ocr) is not null then round(coalesce(de.tax_amount_verified, de.tax_amount_ocr) / coalesce(de.subtotal_verified, de.subtotal_ocr) * 100::numeric, 2)
                    else null::numeric
                end as charged_gst_rate
           from line_agg la
             join document_extraction de on de.id = la.document_extraction_id
             left join v_bill_primary_entry bpe on bpe.document_extraction_id = de.id
        )
 select b.bill_id,
    b.entry_id,
    e.vendor_id,
    v.display_name as vendor_display_name,
    e.department_id,
    d.name as department_name,
    b.line_count,
    b.lines_with_hsn,
    b.lines_matched,
    b.hsn_coverage_pct,
    b.taxable_value,
    b.tax_amount,
    coalesce(b.bill_total, e.amount) as billed_amount,
    b.implied_gst_rate,
    b.charged_gst_rate,
        case
            when b.implied_gst_rate is not null and b.charged_gst_rate is not null then round(b.charged_gst_rate - b.implied_gst_rate, 2)
            else null::numeric
        end as rate_gap_pp,
    b.implied_gst_rate is not null and b.charged_gst_rate is not null and abs(b.charged_gst_rate - b.implied_gst_rate) > 0.15 as is_anomaly,
    e.event_id
   from bill b
     left join entries e on e.id = b.entry_id
     left join vendor v on v.id = e.vendor_id
     left join department d on d.id = e.department_id;

-- v_rupee_provenance_line (line grain -- MANDATORY v_bill_primary_entry swap)
create or replace view public.v_rupee_provenance_line with (security_invoker = true) as
 with rr_dedup as (
         select distinct on (rr.line_item_id) rr.line_item_id,
            rr.id as rate_reference_id,
            rr.net_rate as rr_net_rate,
            rr.discount_pct as rr_discount_pct,
            rr.item_family_id,
            rr.item_catalog_id,
            rr.unit_normalized as rr_unit_normalized
           from rate_reference rr
          where rr.line_item_id is not null
          order by rr.line_item_id, rr.id desc
        )
 select bpe.entry_id,
    li.document_extraction_id,
    li.id as line_item_id,
    li.line_order as line_number,
    coalesce(li.description_verified, li.description_ocr) as description,
    coalesce(li.hsn_sac_code_verified, li.hsn_sac_code_ocr) as hsn_sac,
    coalesce(li.quantity_verified, li.quantity_ocr) as quantity,
    coalesce(li.unit_verified, li.unit_ocr) as unit,
    li.unit_normalized,
    coalesce(li.rate_verified, li.rate_ocr) as net_rate,
    coalesce(li.amount_verified, li.amount_ocr) as line_amount,
    coalesce(li.discount_verified, li.discount_ocr) as discount_note,
    rrd.rate_reference_id,
    rrd.rr_discount_pct as discount_pct,
    rrd.item_family_id,
    fam.label as item_family_label,
    rrd.item_catalog_id,
    ic.canonical_label as item_catalog_label,
    round(rb.median_rate::numeric, 2) as benchmark_median_rate,
    rb.observation_count as benchmark_observation_count,
    rb.vendor_count as benchmark_vendor_count,
        case
            when rb.median_rate is not null and rb.median_rate <> 0::double precision and coalesce(rrd.rr_net_rate, li.rate_verified, li.rate_ocr) is not null then round(((coalesce(rrd.rr_net_rate, li.rate_verified, li.rate_ocr)::double precision - rb.median_rate) / rb.median_rate * 100::double precision)::numeric, 2)
            else null::numeric
        end as rate_vs_benchmark_pct,
    e.department_id,
    e.event_id
   from document_extraction_line_item li
     join document_extraction de on de.id = li.document_extraction_id
     left join v_bill_primary_entry bpe on bpe.document_extraction_id = de.id
     left join entries e on e.id = bpe.entry_id
     left join rr_dedup rrd on rrd.line_item_id = li.id
     left join item_family fam on fam.id = rrd.item_family_id
     left join item_catalog ic on ic.id = rrd.item_catalog_id
     left join v_rate_benchmark rb on rb.item_family_id = rrd.item_family_id and not rb.unit_normalized is distinct from coalesce(rrd.rr_unit_normalized, li.unit_normalized) and not rb.event_id is distinct from e.event_id;

-- v_tax_credit_exposure (sums tax per bill -- MANDATORY v_bill_primary_entry swap)
create or replace view public.v_tax_credit_exposure with (security_invoker = true) as
 with bill_candidate as (
         select de.id as document_extraction_id,
            bpe.entry_id,
            coalesce(de.tax_amount_verified, de.tax_amount_ocr) as tax_amount
           from document_extraction de
             left join v_bill_primary_entry bpe on bpe.document_extraction_id = de.id
          where de.created_at > (now() - '2 years'::interval) and coalesce(de.tax_amount_verified, de.tax_amount_ocr) is not null and coalesce(de.tax_amount_verified, de.tax_amount_ocr) > 0::numeric
        ), bill_entry_prefilter as (
         select bc.document_extraction_id,
            bc.tax_amount,
            e.vendor_id,
            v.display_name as vendor_display_name,
            e.department_id,
            d.name as department_name,
            e.event_id
           from bill_candidate bc
             join entries e on e.id = bc.entry_id
             left join vendor v on v.id = e.vendor_id
             left join department d on d.id = e.department_id
          where e.is_void = false
        ), bill_entry as (
         select bep.document_extraction_id,
            bep.tax_amount,
            bep.vendor_id,
            bep.vendor_display_name,
            bep.department_id,
            bep.department_name,
            bep.event_id,
            (exists ( select 1
                   from reconciliation_exception re
                  where re.document_extraction_id = bep.document_extraction_id and re.status = 'open'::text and (re.exception_type = any (array['vendor_gstin_invalid_checksum'::text, 'buyer_gstin_invalid_checksum'::text, 'gst_recipient_compliance_missing'::text])))) as has_open_credit_exception
           from bill_entry_prefilter bep
        )
 select vendor_id,
    vendor_display_name,
    department_id,
    department_name,
    event_id,
    count(*) as bill_count,
    coalesce(sum(tax_amount), 0::numeric) as total_tax_amount,
    coalesce(sum(tax_amount) filter (where has_open_credit_exception), 0::numeric) as at_risk_tax_amount,
    coalesce(sum(tax_amount) filter (where not has_open_credit_exception), 0::numeric) as claimable_tax_amount
   from bill_entry
  group by vendor_id, vendor_display_name, department_id, department_name, event_id;

-- ===========================================================================
-- 5. v_vendor_spend / v_vendor_scorecard (scorecard reads spend -> order matters)
-- ===========================================================================
create or replace view public.v_vendor_spend with (security_invoker = true) as
 with entry_docs as (
         select distinct l.entry_id
           from entry_bill_link l
        )
 select v.id as vendor_id,
    v.display_name,
    v.normalized_name,
    v.is_confirmed,
    e.event_id,
    count(e.id) as entry_count,
    sum(e.amount) as total_amount,
    min(e.date) as first_entry_date,
    max(e.date) as last_entry_date,
    count(distinct ed.entry_id) as entries_with_documents,
        case
            when count(e.id) = 0 then null::numeric
            else round(count(distinct ed.entry_id)::numeric / count(e.id)::numeric * 100::numeric, 2)
        end as document_coverage_pct
   from vendor v
     left join entries e on e.vendor_id = v.id and e.is_void = false
     left join entry_docs ed on ed.entry_id = e.id
  group by v.id, v.display_name, v.normalized_name, v.is_confirmed, e.event_id;

create or replace view public.v_vendor_scorecard with (security_invoker = true) as
 with base as (
         select vs.vendor_id,
            vs.display_name,
            vs.normalized_name,
            vs.is_confirmed,
            vs.event_id,
            vs.entry_count,
            vs.total_amount,
            vs.first_entry_date,
            vs.last_entry_date,
            vs.entries_with_documents,
            vs.document_coverage_pct
           from v_vendor_spend vs
          where vs.entry_count > 0
        ), comparable_obs as (
         select rr.item_family_id,
            rr.unit_normalized,
            e.event_id,
            rr.vendor_id,
            rr.net_rate
           from rate_reference rr
             left join entries e on e.id = rr.entry_id
          where rr.is_comparable = true and rr.item_family_id is not null and rr.net_rate is not null
        ), price_medians as (
         select comparable_obs.item_family_id,
            comparable_obs.unit_normalized,
            comparable_obs.event_id,
            percentile_cont(0.5::double precision) within group (order by (comparable_obs.net_rate::double precision)) as median_rate
           from comparable_obs
          group by comparable_obs.item_family_id, comparable_obs.unit_normalized, comparable_obs.event_id
        ), price_position as (
         select co.vendor_id,
            co.event_id,
            avg(co.net_rate::double precision / pm.median_rate) as avg_price_ratio,
            count(*) as priced_observation_count
           from comparable_obs co
             join price_medians pm on pm.item_family_id = co.item_family_id and not pm.unit_normalized is distinct from co.unit_normalized and not pm.event_id is distinct from co.event_id
          where pm.median_rate > 0::double precision
          group by co.vendor_id, co.event_id
        ), discount_given as (
         select rr.vendor_id,
            e.event_id,
            avg(rr.discount_pct) as avg_discount_pct,
            count(rr.discount_pct) as discount_observation_count
           from rate_reference rr
             left join entries e on e.id = rr.entry_id
          where rr.discount_pct is not null
          group by rr.vendor_id, e.event_id
        ), vendor_flags_all as (
         select f.vendor_id,
            fe.event_id,
            count(*) as flag_history_count,
            count(*) filter (where f.status = 'open'::text) as open_flag_count,
            sum(f.amount_at_risk) filter (where f.status = 'open'::text) as open_flag_amount_at_risk
           from flags f
             left join entries fe on fe.id = f.entry_id
          where f.vendor_id is not null
          group by f.vendor_id, fe.event_id
        ), gstin_exceptions as (
         select e.vendor_id,
            e.event_id,
            bool_or(re.status = 'open'::text) as has_open_gstin_exception
           from reconciliation_exception re
             join document_extraction de on de.id = re.document_extraction_id
             left join v_bill_primary_entry bpe on bpe.document_extraction_id = de.id
             join entries e on e.id = bpe.entry_id
          where (re.exception_type = any (array['vendor_gstin_invalid_checksum'::text, 'vendor_gstin_is_own_org'::text])) and e.vendor_id is not null
          group by e.vendor_id, e.event_id
        )
 select b.vendor_id,
    b.display_name,
    b.normalized_name,
    b.is_confirmed,
    b.event_id,
    b.entry_count,
    b.total_amount,
    b.first_entry_date,
    b.last_entry_date,
    b.entries_with_documents,
    b.document_coverage_pct,
    vc.pct_of_total_spend,
    v.gstin,
        case
            when v.gstin is null then 'missing'::text
            when coalesce(ge.has_open_gstin_exception, false) then 'flagged'::text
            else 'valid'::text
        end as gstin_status,
    round(pp.avg_price_ratio::numeric, 3) as avg_price_ratio,
    coalesce(pp.priced_observation_count, 0::bigint) as priced_observation_count,
    round(dg.avg_discount_pct, 2) as avg_discount_pct,
    coalesce(dg.discount_observation_count, 0::bigint) as discount_observation_count,
    coalesce(vf.flag_history_count, 0::bigint) as flag_history_count,
    coalesce(vf.open_flag_count, 0::bigint) as open_flag_count,
    vf.open_flag_amount_at_risk
   from base b
     join vendor v on v.id = b.vendor_id
     left join v_vendor_concentration vc on vc.vendor_id = b.vendor_id and not vc.event_id is distinct from b.event_id
     left join price_position pp on pp.vendor_id = b.vendor_id and not pp.event_id is distinct from b.event_id
     left join discount_given dg on dg.vendor_id = b.vendor_id and not dg.event_id is distinct from b.event_id
     left join vendor_flags_all vf on vf.vendor_id = b.vendor_id and not vf.event_id is distinct from b.event_id
     left join gstin_exceptions ge on ge.vendor_id = b.vendor_id and not ge.event_id is distinct from b.event_id;

-- ===========================================================================
-- 6. Review queues
-- ===========================================================================

-- v_review_queue: bill grain. coalesce(de.entry_id, sd.entry_id) -> bpe.entry_id.
-- ex_matched_by_entry: an entry-level exception now maps to every bill linked
-- to that entry (was: the bill whose scalar entry_id matched, plus the doc's
-- bills when the match was doc-level).
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
  where de.verified_at is null or not (sd.match_status = 'no_entry_expected'::text or bpe.entry_id is not null and e.admin_head_id is not null and e.zone_id is not null and e.sub_department_id is not null)
  order by (coalesce(x.rank, 0)) desc, r.extraction_confidence nulls first, (coalesce(e.amount, de.total_amount_ocr)) desc nulls last, de.id;

-- v_review_queue_all: same swap; keeps its own extra columns (verified_at) and
-- the 2-year window. entry_id column -> bill's primary linked entry.
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
    sd.event_id
   from document_extraction de
     join source_document sd on sd.id = de.source_document_id
     left join ocr_extraction_run r on r.id = de.current_extraction_run_id
     left join v_bill_primary_entry bpe on bpe.document_extraction_id = de.id
     left join entries e on e.id = bpe.entry_id
     left join open_by_bill x on x.document_extraction_id = de.id
  where de.created_at > (now() - '2 years'::interval)
  order by (coalesce(x.rank, 0)) desc, r.extraction_confidence nulls first, (coalesce(e.amount, de.total_amount_ocr)) desc nulls last, de.id;

-- ===========================================================================
-- 7. SECURITY DEFINER functions
-- ===========================================================================

-- private.verify_document_extraction: de.entry_id -> v_bill_primary_entry.
-- rate_reference.entry_id stays scalar (a reference-price row attributes to the
-- bill's primary linked entry); v_observed_date likewise.
create or replace function private.verify_document_extraction(p_document_extraction_id bigint, p_header jsonb, p_line_items jsonb, p_vendor_id bigint, p_expected_extraction_run_id bigint default null::bigint)
 returns table(document_extraction_id bigint, line_items_updated integer, rate_reference_rows_inserted integer)
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_doc_extraction_id bigint;
  v_source_document_id bigint;
  v_entry_id bigint;
  v_current_run_id bigint;
  v_observed_date date;
  v_item jsonb;
  v_line_item_id bigint;
  v_updated_count int := 0;
  v_inserted_count int := 0;
  v_claimed_by uuid;
  v_claimed_at timestamptz;
  v_claimant_name text;
begin
  if not (select private.is_reviewer_or_admin()) then
    raise exception 'Verifying an extraction requires the reviewer or admin role.';
  end if;

  select de.id, de.source_document_id, de.current_extraction_run_id
    into v_doc_extraction_id, v_source_document_id, v_current_run_id
  from public.document_extraction de
  where de.id = p_document_extraction_id;

  if v_doc_extraction_id is null then
    raise exception 'No document_extraction row exists for id %.', p_document_extraction_id;
  end if;

  -- Primary linked entry (largest amount, id tie-break) -- the scalar
  -- attribution point for rate_reference + observed_date.
  select bpe.entry_id into v_entry_id
  from public.v_bill_primary_entry bpe
  where bpe.document_extraction_id = v_doc_extraction_id;

  if not (select private.can_see_source_document(v_source_document_id)) then
    raise exception 'You do not have visibility into source_document %.', v_source_document_id;
  end if;

  select sd.claimed_by, sd.claimed_at into v_claimed_by, v_claimed_at
  from public.source_document sd
  where sd.id = v_source_document_id;

  if v_claimed_by is not null
     and v_claimed_by is distinct from (select auth.uid())
     and v_claimed_at > now() - interval '15 minutes' then
    select sp.display_name into v_claimant_name
    from public.staff_profile sp
    where sp.id = v_claimed_by;

    raise exception 'SAVE_CONFLICT: This bill is currently claimed by % — you can''t save until you take it over.',
      coalesce(v_claimant_name, 'another reviewer');
  end if;

  if p_expected_extraction_run_id is not null
     and v_current_run_id is distinct from p_expected_extraction_run_id then
    raise exception 'SAVE_CONFLICT: This document was re-extracted since you opened it — reload to see the latest version before saving.';
  end if;

  if v_entry_id is not null then
    select e.date into v_observed_date from public.entries e where e.id = v_entry_id;
  end if;
  v_observed_date := coalesce(v_observed_date, current_date);

  update public.document_extraction de set
    vendor_name_verified    = p_header->>'vendor_name',
    vendor_gstin_verified   = p_header->>'vendor_gstin',
    vendor_phone_verified   = p_header->>'vendor_phone',
    vendor_email_verified   = p_header->>'vendor_email',
    vendor_address_verified = p_header->>'vendor_address',
    invoice_number_verified = p_header->>'invoice_number',
    invoice_date_verified   = (p_header->>'invoice_date')::date,
    subtotal_verified       = (p_header->>'subtotal')::numeric,
    tax_amount_verified     = (p_header->>'tax_amount')::numeric,
    total_amount_verified   = (p_header->>'total_amount')::numeric,
    notes_verified          = p_header->>'notes',
    verified_at             = now(),
    verified_by             = (select auth.uid())
  where de.id = v_doc_extraction_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_line_items, '[]'::jsonb))
  loop
    v_line_item_id := (v_item->>'id')::bigint;

    update public.document_extraction_line_item li set
      description_verified      = v_item->>'description',
      hsn_sac_code_verified      = v_item->>'hsn_sac_code',
      quantity_verified          = (v_item->>'quantity')::numeric,
      quantity_raw_text_verified = v_item->>'quantity_raw_text',
      unit_verified              = v_item->>'unit',
      unit_normalized            = v_item->>'unit_normalized',
      rate_verified              = (v_item->>'rate')::numeric,
      discount_verified          = v_item->>'discount',
      amount_verified            = (v_item->>'amount')::numeric
    where li.id = v_line_item_id
      and li.document_extraction_id = v_doc_extraction_id;

    if found then
      v_updated_count := v_updated_count + 1;

      if p_vendor_id is not null and (v_item->>'rate') is not null then
        insert into public.rate_reference (
          item_description_raw, vendor_id, net_rate, unit_normalized,
          observed_date, entry_id, line_item_id
        ) values (
          coalesce(v_item->>'description', ''),
          p_vendor_id,
          (v_item->>'rate')::numeric,
          v_item->>'unit_normalized',
          v_observed_date,
          v_entry_id,
          v_line_item_id
        );
        v_inserted_count := v_inserted_count + 1;
      end if;
    end if;
  end loop;

  return query select v_doc_extraction_id, v_updated_count, v_inserted_count;
end;
$function$;

-- public.match_candidate_entries: drop the 4-arg form, replace with a 5-arg
-- form. The global "already matched anywhere" exclusion is GONE (a matched
-- entry can legitimately take a second bill); instead the caller passes
-- p_exclude_entry_ids = the entries already linked to THIS bill.
drop function if exists public.match_candidate_entries(bigint, numeric, text, text);

create function public.match_candidate_entries(
  p_vendor_id bigint default null,
  p_amount numeric default null,
  p_invoice_number text default null,
  p_vendor_raw text default null,
  p_exclude_entry_ids bigint[] default null
)
returns table (
  id bigint,
  vendor_raw text,
  vendor_id bigint,
  amount numeric,
  date date,
  invoice_number text,
  department_id bigint,
  ubbl_number text,
  main_number text,
  admin_head_id bigint,
  zone_id bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_invoice_number_normalized text :=
    nullif(upper(regexp_replace(coalesce(p_invoice_number, ''), '[^A-Za-z0-9]', '', 'g')), '');
  v_vendor_raw_normalized text := nullif(lower(trim(coalesce(p_vendor_raw, ''))), '');
begin
  -- Loosen pg_trgm's default 0.3 for the `%` pre-filter branch. Set in the
  -- body (is_local => transaction-scoped) rather than as a function property:
  -- Supabase's migration role cannot apply a `SET pg_trgm.*` clause at CREATE
  -- time (the placeholder GUC is only registered once the extension library
  -- loads). Judgment call, not spec -- this is a superset pre-filter, not the
  -- final similarity gate (lib/matching.ts's vendorSimilarity).
  perform set_config('pg_trgm.similarity_threshold', '0.15', true);

  return query
  select
    e.id, e.vendor_raw, e.vendor_id, e.amount, e.date, e.invoice_number,
    e.department_id, e.ubbl_number, e.main_number, e.admin_head_id, e.zone_id
  from public.entries e
  where e.is_void = false
    and (p_exclude_entry_ids is null or e.id <> all (p_exclude_entry_ids))
    and (
      (p_vendor_id is not null and e.vendor_id = p_vendor_id)

      or (
        p_amount is not null and e.amount is not null
        and p_amount > 0 and e.amount > 0
        and e.amount between p_amount * 0.7 and p_amount / 0.7
      )

      or (
        v_invoice_number_normalized is not null
        and upper(regexp_replace(e.invoice_number, '[^A-Za-z0-9]', '', 'g')) = v_invoice_number_normalized
      )

      or (
        v_vendor_raw_normalized is not null
        and e.vendor_raw is not null
        and lower(e.vendor_raw) OPERATOR(extensions.%) v_vendor_raw_normalized
      )
    )
  order by
    (p_vendor_id is not null and e.vendor_id = p_vendor_id) desc,
    (
      v_invoice_number_normalized is not null
      and upper(regexp_replace(e.invoice_number, '[^A-Za-z0-9]', '', 'g')) = v_invoice_number_normalized
    ) desc,
    e.date desc nulls last
  limit 300;
end;
$$;

revoke all on function public.match_candidate_entries(bigint, numeric, text, text, bigint[])
  from public, anon, authenticated;
grant execute on function public.match_candidate_entries(bigint, numeric, text, text, bigint[])
  to authenticated;

-- ===========================================================================
-- 8. private.can_see_source_document -- DEAD LAST (RLS gate)
-- ===========================================================================
-- Semantic shift (per plan): a document linked to entries in two departments
-- becomes visible to reviewers in EITHER (OR semantics). A document with no
-- link at all still falls to the "unassigned triage pool" branch
-- (non-admin staff), exactly as an entry_id-null document did before.
create or replace function private.can_see_source_document(p_source_document_id bigint)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select exists (
    select 1
    from public.source_document sd
    where sd.id = p_source_document_id
      and (
        (select private.is_superadmin())
        or exists (
          select 1 from public.source_document_assignee sda
          where sda.source_document_id = sd.id
            and sda.staff_id = (select auth.uid())
        )
        or (
          not exists (
            select 1 from public.source_document_assignee sda
            where sda.source_document_id = sd.id
          )
          and (select private.is_staff())
          and (
            case
              when exists (
                select 1 from public.entry_bill_link l where l.source_document_id = sd.id
              )
              then exists (
                select 1
                from public.entry_bill_link l
                join public.entries e on e.id = l.entry_id
                where l.source_document_id = sd.id
                  and (select private.can_see_department(e.department_id))
              )
              else not (select private.is_admin_or_above())
            end
          )
        )
      )
  );
$function$;
