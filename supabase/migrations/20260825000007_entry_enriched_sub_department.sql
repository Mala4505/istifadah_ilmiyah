-- Sub-department feature: expose the sub-department a reviewer assigns on
-- v_entry_enriched, so it's visible/exportable anywhere the enriched view is
-- read, not just inside /review. Base definition:
-- 20260822000011_analytics_event_scoping.sql:237-306 (last migration-tracked
-- version, added event_id as the final column). Only the two new
-- sub_department_id/sub_department_name output columns are added, at the
-- very end of the select list -- CREATE OR REPLACE VIEW only tolerates
-- appending columns after the existing last column; inserting them any
-- earlier (e.g. next to admin_head_id/zone_id, where they'd read more
-- naturally) shifts every later column's position, which Postgres treats as
-- renaming them and refuses. Same reasoning 20260822000011 already
-- documents for why event_id itself landed at the end rather than beside
-- import_batch_id.
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
  coalesce(doc.document_count, 0) as document_count,
  e.event_id,
  e.sub_department_id,
  sub.name as sub_department_name
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
) doc on doc.entry_id = e.id
left join public.sub_department sub on sub.id = e.sub_department_id;
