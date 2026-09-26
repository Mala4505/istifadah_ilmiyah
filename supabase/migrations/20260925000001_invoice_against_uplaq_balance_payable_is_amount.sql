-- Flip invoice_against_uplaq's main entries.amount from Invoice Amount to
-- Balance Payable.
--
-- WHY: BALANCE PAYABLE = Invoice Amount - Advance Uplaq Amount - 1% TDS
-- (verified to the rupee against real rows, 20260828000002). That migration
-- also documents that entries.settles_entry_id -- the column meant to link
-- an IAU row back to the Advance Payment row it settles -- is never
-- populated, because the portal gives no reliable identifier to join the two
-- on. So an IAU row and the Advance Payment row it settles sit in `entries`
-- as two unrelated rows: the advance's Uplaq Amount, and (until this
-- migration) the IAU row's full Invoice Amount. Summing both double-counts
-- the advance leg of the transaction. Balance Payable is what remains AFTER
-- that advance, so Uplaq Amount + Balance Payable nets to the true total
-- (less TDS) instead of double-counting it.
--
-- Same class-table-inheritance shape advance_payment_detail already uses for
-- its own "other" column (20260827000001): the column entries.amount stops
-- authoritatively holding is kept alongside it on the detail table, not
-- discarded.

begin;

alter table public.invoice_against_uplaq_detail
  add column invoice_amount numeric(14,2);

comment on column public.invoice_against_uplaq_detail.invoice_amount is
  'The tab''s raw Invoice Amount, kept for reference now that entries.amount holds Balance Payable instead (20260925000001).';

-- Preserve the value entries.amount currently holds (Invoice Amount, per
-- 20260828000002's original decision) before it is overwritten below.
update public.invoice_against_uplaq_detail iad
   set invoice_amount = e.amount
  from public.entries e
 where e.id = iad.entry_id
   and e.type = 'invoice_against_uplaq';

-- Flip entries.amount to Balance Payable. Guarded on balance_payable is not
-- null so a row that never had one keeps its existing amount rather than
-- being nulled out.
update public.entries e
   set amount = iad.balance_payable
  from public.invoice_against_uplaq_detail iad
 where e.id = iad.entry_id
   and e.type = 'invoice_against_uplaq'
   and iad.balance_payable is not null;

-- Surface both IAU detail columns on v_entry_enriched, same as
-- advance_payment_detail.invoice_amount already is. Full view body copied
-- verbatim from its current live definition (20260919000002, the latest
-- migration to touch it) with the invoice_against_uplaq_detail join and its
-- two columns appended -- CREATE OR REPLACE VIEW only tolerates appending
-- columns after the existing last one.
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
    iad.invoice_amount as iau_invoice_amount
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
     left join advance_payment_detail apd on apd.entry_id = e.id
     left join invoice_against_uplaq_detail iad on iad.entry_id = e.id;

commit;
