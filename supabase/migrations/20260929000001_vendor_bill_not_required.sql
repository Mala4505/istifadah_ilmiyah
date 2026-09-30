-- Bill-exempt vendors (docs/bill-exempt-vendor-plan.md, 2026-09-29).
--
-- Some vendors never issue a bill -- Burhani Hospital Surat is reimbursed
-- through the Sehhat batch with no PDF and no invoice to link. Every one of
-- its entries currently reads as "Awaiting bill" and lands in the D-06
-- undocumented pile, which is noise, not a gap anyone can close.
--
-- Decision (operator): the exemption is VENDOR-WIDE, not scoped to a
-- department. An entry is bill-exempt when its vendor, or the vendor that one
-- is merged into (vendor.cluster_group_id), has bill_not_required = true --
-- so a merged-in spelling of the same hospital inherits the exemption.
--
-- Deliberately NOT touched: match_candidate_entries. An exempt vendor's entry
-- stays linkable, so a bill that does turn up can still be attached.

begin;

-- ---- 1. the flag ------------------------------------------------------------
-- Same shape as use_line_item_template (20260912000001): a plain boolean on
-- vendor, written by admins only through the existing vendor update policy.
alter table public.vendor
  add column bill_not_required boolean not null default false;

comment on column public.vendor.bill_not_required is
  'True = this vendor issues no bills; its entries (and those of vendors merged into it) are not expected to have a linked document. Excluded from "Awaiting bill" and v_entries_without_bill. 2026-09-29.';

-- Burhani Hospital Surat. normalized_name is lib/normalize.ts's
-- normalizeVendorName('Burhani Hospital Surat'). A no-op if the vendor does
-- not exist yet -- an admin can tick it in Settings -> Vendors instead.
update public.vendor
   set bill_not_required = true
 where normalized_name = 'burhani hospital surat';

-- ---- 2. v_entry_enriched.bill_exempt ----------------------------------------
-- Body copied verbatim from its latest definition
-- (20260925000001_invoice_against_uplaq_balance_payable_is_amount.sql) with a
-- join to the vendor's merge root and one column appended -- CREATE OR REPLACE
-- VIEW only tolerates appending columns after the existing last one.
-- security_invoker re-asserted (see 20260908000003 for the regression that
-- omitting it caused).
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
     left join cost_center cc on cc.id = e.cost_center_id
     left join hub_status hs on hs.id = e.hub_status_id
     left join ( select l.entry_id,
            count(distinct l.source_document_id) as document_count
           from entry_bill_link l
          group by l.entry_id) doc on doc.entry_id = e.id
     left join sub_department sub on sub.id = e.sub_department_id
     left join reimbursement_detail rd on rd.entry_id = e.id
     left join advance_payment_detail apd on apd.entry_id = e.id
     left join invoice_against_uplaq_detail iad on iad.entry_id = e.id;

-- ---- 3. D-06 undocumented pile: drop exempt entries ------------------------
-- Bodies from 20260908000003_entry_bill_link_readers.sql, with the same
-- exempt test (own vendor or merge root flagged) added to the base filter.
-- Output columns unchanged.
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
            and not exists (
              select 1 from vendor xv
              left join vendor xr on xr.id = xv.cluster_group_id
              where xv.id = e.vendor_id
                and (xv.bill_not_required or coalesce(xr.bill_not_required, false))
            )
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
            and not exists (
              select 1 from vendor xv
              left join vendor xr on xr.id = xv.cluster_group_id
              where xv.id = e.vendor_id
                and (xv.bill_not_required or coalesce(xr.bill_not_required, false))
            )
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

commit;
