-- Renamed from `budget_category` to `cost_center` (confirmed 2026-08-11, MASTER-PLAN
-- §3.1/§17.4) -- Tally terminology, not a redesign. Same table, same data (the bracket
-- half of labels like "Dummas (AVIT)"), only the name was wrong. A table rename carries
-- FKs and grants with it automatically (Postgres tracks by OID, same reasoning as
-- 20260811000001's admin_head rename); only the manually-named index/policies and the
-- one dependent view need restating.

drop view if exists public.v_entry_enriched;

alter table public.budget_category rename to cost_center;
alter index public.budget_category_cluster_idx rename to cost_center_cluster_idx;
alter policy budget_category_select on public.cost_center rename to cost_center_select;
alter policy budget_category_insert_admin on public.cost_center rename to cost_center_insert_admin;
alter policy budget_category_update_admin on public.cost_center rename to cost_center_update_admin;

alter table public.entries rename column budget_category_id to cost_center_id;
alter index public.entries_budget_category_idx rename to entries_cost_center_idx;

-- v_entry_enriched recreated identically to 20260811000004's version, cost_center in
-- place of budget_category (join alias bc -> cc, output columns cost_center_id/name).
create view public.v_entry_enriched with (security_invoker = true) as
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
  select sd.entry_id, count(*) as document_count
  from public.source_document sd
  where sd.entry_id is not null
  group by sd.entry_id
) doc on doc.entry_id = e.id;

grant select on public.v_entry_enriched to authenticated;
