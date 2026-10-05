-- report-data-gaps-plan.md Phase 6 (2026-10-05): remove cost_center entirely;
-- "budget category" now comes from the budget head.
--
-- cost_center was meant to be the cross-department category, i.e. the
-- bracket half of labels like "Venue Setup (Electricals)". budget_head.
-- short_label already holds exactly that, so the user chose to drop the
-- separate master table instead of seeding it (0 of 1,821 entries ever had a
-- cost_center_id).
--
-- New: v_budget_head_category maps each budget_head to a category key + label.
--   key   = short_label lower-cased, the two known misspellings of
--           "stationery" corrected, then every non-alphanumeric removed. So
--           "Venue set up" / "Venue Setup" / "Venue setup" -> 'venuesetup',
--           "Mawaid / Snacks" / "Mawaid/Snacks" -> 'mawaidsnacks'. Exact
--           normalised match only, no fuzzy merging.
--   label = the spelling used by the most live entries in that key (ties ->
--           alphabetical); heads with no entries fall back to their own label.
--
-- Views changed (all dropped + recreated: removing columns, and
-- v_outstanding_advance_ageing's `select e.*` CTE pins every entries column):
--   v_entry_enriched             -- cost_center_id / cost_center_name removed
--   v_outstanding_advance_ageing -- body unchanged
--   v_rupee_provenance_entry     -- budget_category_id removed; budget_category_label
--                                   is now the derived category (null = no head)
--   v_budget_category_mix        -- grouped by budget category, not cost_center
--   v_zone_category_matrix       -- same
-- No other view or function depends on these (checked via pg_depend/prosrc).

drop view public.v_budget_category_mix;
drop view public.v_zone_category_matrix;
drop view public.v_rupee_provenance_entry;
drop view public.v_outstanding_advance_ageing;
drop view public.v_entry_enriched;

-- Drops entries_cost_center_idx and the FK along with the column.
alter table public.entries drop column cost_center_id;
-- Drops its policies, indexes and self-referencing FK with it.
drop table public.cost_center;

-- ----------------------------------------------------------------------------
-- v_budget_head_category
-- ----------------------------------------------------------------------------
create view public.v_budget_head_category with (security_invoker = true) as
with head_key as (
  select
    bh.id as budget_head_id,
    coalesce(bh.short_label, bh.raw_label) as label,
    regexp_replace(
      replace(replace(lower(coalesce(bh.short_label, bh.raw_label)), 'stationary', 'stationery'), 'staionery', 'stationery'),
      '[^a-z0-9]+', '', 'g'
    ) as category_key
  from public.budget_head bh
),
key_label as (
  select hk.category_key, mode() within group (order by hk.label) as category_label
  from head_key hk
  join public.entries e on e.budget_head_id = hk.budget_head_id and e.is_void = false
  group by hk.category_key
)
select
  hk.budget_head_id,
  hk.category_key,
  coalesce(kl.category_label, hk.label) as category_label
from head_key hk
left join key_label kl on kl.category_key = hk.category_key;

-- ----------------------------------------------------------------------------
-- v_entry_enriched -- body from 20260929000001 minus the cost_center columns/join
-- ----------------------------------------------------------------------------
create view public.v_entry_enriched with (security_invoker = true) as
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
    apd.invoice_amount as advance_invoice_amount,
    e.void_note,
    iad.balance_payable as iau_balance_payable,
    iad.invoice_amount as iau_invoice_amount,
    (coalesce(v.bill_not_required, false) or coalesce(vr.bill_not_required, false)) as bill_exempt
   from entries e
     left join department d on d.id = e.department_id
     left join budget_head bh on bh.id = e.budget_head_id
     left join vendor v on v.id = e.vendor_id
     left join vendor vr on vr.id = v.cluster_group_id
     left join entry_status st on st.id = e.status_id
     left join admin_head ah on ah.id = e.admin_head_id
     left join zone z on z.id = e.zone_id
     left join hub_status hs on hs.id = e.hub_status_id
     left join ( select l.entry_id,
            count(distinct l.source_document_id) as document_count
           from entry_bill_link l
          group by l.entry_id) doc on doc.entry_id = e.id
     left join sub_department sub on sub.id = e.sub_department_id
     left join reimbursement_detail rd on rd.entry_id = e.id
     left join advance_payment_detail apd on apd.entry_id = e.id
     left join invoice_against_uplaq_detail iad on iad.entry_id = e.id;

-- ----------------------------------------------------------------------------
-- v_outstanding_advance_ageing -- body from 20260903000014, unchanged
-- ----------------------------------------------------------------------------
create view public.v_outstanding_advance_ageing with (security_invoker = true) as
with advances as (
  select e.*
  from public.entries e
  where e.type = 'advance_payment'
    and e.is_void = false
),
settled_advance_ids as (
  select distinct settles_entry_id
  from public.entries
  where settles_entry_id is not null
)
select
  a.id as entry_id,
  a.department_id,
  d.name as department_name,
  a.admin_head_id,
  ah.name as admin_head_name,
  a.vendor_id,
  v.display_name as vendor_display_name,
  a.amount as advance_amount,
  a.date as advance_date,
  (current_date - a.date) as days_outstanding,
  case
    when a.date is null then null
    when current_date - a.date <= 30 then '0-30'
    when current_date - a.date <= 60 then '31-60'
    when current_date - a.date <= 90 then '61-90'
    else '90+'
  end as age_bucket,
  apd.invoice_amount,
  a.event_id
from advances a
left join settled_advance_ids s on s.settles_entry_id = a.id
left join public.department d on d.id = a.department_id
left join public.admin_head ah on ah.id = a.admin_head_id
left join public.vendor v on v.id = a.vendor_id
left join public.advance_payment_detail apd on apd.entry_id = a.id
where s.settles_entry_id is null;

-- ----------------------------------------------------------------------------
-- v_rupee_provenance_entry -- body from 20260908000003; budget category now
-- derived from the budget head
-- ----------------------------------------------------------------------------
create view public.v_rupee_provenance_entry with (security_invoker = true) as
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
    bc.category_label as budget_category_label,
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
     left join v_budget_head_category bc on bc.budget_head_id = e.budget_head_id
     left join zone z on z.id = e.zone_id
     left join lateral ( select count(*) as line_item_count
           from document_extraction_line_item dli
          where dli.document_extraction_id = ed.document_extraction_id) li on true
  where e.is_void = false;

-- ----------------------------------------------------------------------------
-- v_zone_category_matrix -- A-06, one row per (zone, budget category, event)
-- ----------------------------------------------------------------------------
create view public.v_zone_category_matrix with (security_invoker = true) as
select
  e.zone_id,
  coalesce(z.name, 'Unassigned zone')              as zone_name,
  z.zone_number,
  bc.category_key                                  as budget_category_key,
  coalesce(bc.category_label, 'No budget head')    as budget_category_label,
  e.event_id,
  count(*)                                         as entry_count,
  coalesce(sum(e.amount), 0)                       as total_amount
from public.entries e
left join public.zone z on z.id = e.zone_id
left join public.v_budget_head_category bc on bc.budget_head_id = e.budget_head_id
where e.is_void = false
group by e.zone_id, z.name, z.zone_number, bc.category_key, bc.category_label, e.event_id;

-- ----------------------------------------------------------------------------
-- v_budget_category_mix -- A-07, one row per (budget category, event)
-- ----------------------------------------------------------------------------
create view public.v_budget_category_mix with (security_invoker = true) as
select
  bc.category_key                                  as budget_category_key,
  coalesce(bc.category_label, 'No budget head')    as budget_category_label,
  e.event_id,
  count(*)                                         as entry_count,
  coalesce(sum(e.amount), 0)                       as total_amount
from public.entries e
left join public.v_budget_head_category bc on bc.budget_head_id = e.budget_head_id
where e.is_void = false
group by bc.category_key, bc.category_label, e.event_id;

grant select on
  public.v_budget_head_category,
  public.v_entry_enriched,
  public.v_outstanding_advance_ageing,
  public.v_rupee_provenance_entry,
  public.v_zone_category_matrix,
  public.v_budget_category_mix
to authenticated;
