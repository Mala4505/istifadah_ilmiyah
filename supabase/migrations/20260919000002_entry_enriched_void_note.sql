-- Expose the new entries.void_note (20260919000001) on v_entry_enriched so
-- the entry detail / reconciliation screens can read it like every other
-- e.-prefixed column already surfaced here.
--
-- Full view body copied verbatim from the view's actual current definition,
-- 20260908000003_entry_bill_link_readers.sql -- confirmed the latest full
-- redefinition by grepping supabase/migrations/ for `view public.v_entry_enriched`;
-- 20260908000005_restore_status_view_security_invoker.sql only did a bare
-- `alter view ... set (security_invoker = true)` reloption flip afterwards,
-- it did not touch the body. void_note is appended at the very end of the
-- select list, not next to e.is_void -- CREATE OR REPLACE VIEW refuses to
-- insert a column in the middle of an existing view's output (it would have
-- to rename every column after the insertion point, e.g. "source" shifting
-- into void_note's old position, which Postgres rejects outright), so a new
-- column can only ever be appended at the end.
--
-- security_invoker = true is included in THIS SAME `create or replace view`
-- statement -- 20260908000005 exists precisely because an earlier
-- `create or replace view` without a WITH clause silently reset this view's
-- reloptions and dropped the flag; splitting it into a follow-up `alter view`
-- here would risk repeating that regression.
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
    e.void_note
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

-- CREATE OR REPLACE VIEW keeps existing grants (20260814000009's note) -- no
-- re-grant needed.
