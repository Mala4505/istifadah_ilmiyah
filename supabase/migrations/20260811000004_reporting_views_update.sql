-- Reporting views updated for the 20260811000001-3 renames. Every view here is
-- dropped and recreated (not CREATE OR REPLACE) because the column lists genuinely
-- change, not just their positions -- CREATE OR REPLACE VIEW only tolerates adding
-- columns at the end, not removing/renaming existing ones. security_invoker = true
-- carried over unchanged in every case (§4.4). v_hub_status_ageing, v_open_issues,
-- v_review_queue, v_extraction_correction are untouched: the first still reads
-- hub_status_id/hub_status_changed_at (deliberately deferred, see 20260811000003's
-- header), the rest never referenced entries' money/status columns at all.

drop view if exists public.v_entry_enriched;
drop view if exists public.v_budget_vs_actual;
drop view if exists public.v_vendor_spend;
drop view if exists public.v_zone_spend;
drop view if exists public.v_tenant_main_variance;

-- ----------------------------------------------------------------------------
-- v_entry_enriched -- the one join every other view builds on.
-- ----------------------------------------------------------------------------
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
  e.budget_category_id,
  bc.name as budget_category_name,
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
left join public.budget_category bc on bc.id = e.budget_category_id
left join public.hub_status hs on hs.id = e.hub_status_id
left join (
  select sd.entry_id, count(*) as document_count
  from public.source_document sd
  where sd.entry_id is not null
  group by sd.entry_id
) doc on doc.entry_id = e.id;

-- ----------------------------------------------------------------------------
-- v_budget_vs_actual -- per budget head: latest allocation vs sum(amount).
-- Returns 'no approved budget' rather than -100% when approved_amount = 0 (§3.5).
-- ----------------------------------------------------------------------------
create view public.v_budget_vs_actual with (security_invoker = true) as
with latest_allocation as (
  select distinct on (ba.budget_head_id)
    ba.budget_head_id, ba.as_of, ba.request_amount, ba.approved_amount,
    ba.utilised_amount, ba.balance_amount
  from public.budget_allocation ba
  order by ba.budget_head_id, ba.as_of desc, ba.id desc
),
actual_spend as (
  select e.budget_head_id, sum(e.amount) as actual_amount, count(*) as entry_count
  from public.entries e
  where e.is_void = false and e.budget_head_id is not null
  group by e.budget_head_id
)
select
  bh.id as budget_head_id,
  bh.raw_label,
  bh.short_label,
  bh.department_id,
  la.as_of,
  la.request_amount,
  la.approved_amount,
  la.utilised_amount,
  la.balance_amount,
  coalesce(asp.actual_amount, 0) as actual_amount,
  coalesce(asp.entry_count, 0) as entry_count,
  case
    when la.approved_amount is null or la.approved_amount = 0 then null
    else round(coalesce(asp.actual_amount, 0) / la.approved_amount * 100, 2)
  end as pct_of_approved,
  case
    when la.approved_amount is null or la.approved_amount = 0 then 'no approved budget'
    else null
  end as budget_status_note
from public.budget_head bh
left join latest_allocation la on la.budget_head_id = bh.id
left join actual_spend asp on asp.budget_head_id = bh.id;

-- ----------------------------------------------------------------------------
-- v_vendor_spend -- per vendor: entry count, total, first/last date, document coverage %.
-- ----------------------------------------------------------------------------
create view public.v_vendor_spend with (security_invoker = true) as
select
  v.id as vendor_id,
  v.display_name,
  v.normalized_name,
  v.is_confirmed,
  count(e.id) as entry_count,
  sum(e.amount) as total_amount,
  min(e.date) as first_entry_date,
  max(e.date) as last_entry_date,
  count(distinct sd.entry_id) as entries_with_documents,
  case when count(e.id) = 0 then null
       else round(count(distinct sd.entry_id)::numeric / count(e.id) * 100, 2)
  end as document_coverage_pct
from public.vendor v
left join public.entries e on e.vendor_id = v.id and e.is_void = false
left join public.source_document sd on sd.entry_id = e.id
group by v.id, v.display_name, v.normalized_name, v.is_confirmed;

-- ----------------------------------------------------------------------------
-- v_zone_spend -- per zone: total and entry count. Null zone reported as 'unassigned'
-- so gaps in enrichment are visible rather than invisible.
-- ----------------------------------------------------------------------------
create view public.v_zone_spend with (security_invoker = true) as
select
  z.id as zone_id,
  coalesce(z.name, 'unassigned') as zone_name,
  z.zone_number,
  e.department_id,
  count(e.id) as entry_count,
  sum(e.amount) as total_amount
from public.entries e
left join public.zone z on z.id = e.zone_id
where e.is_void = false
group by z.id, z.name, z.zone_number, e.department_id;

-- ----------------------------------------------------------------------------
-- v_department_audit_variance -- renamed from v_tenant_main_variance (§3.4: there is
-- no separate second amount to diff anymore). DELIBERATELY SIMPLIFIED for now: shows
-- entries missing a Main/Audit-side match (no main_number), with variance_reason where
-- the source explains it. The richer check you described -- do a bill's consolidated,
-- split-across-heads entries sum back to its original export total -- needs a defined
-- grouping key (what identifies "the same bill" across multiple entries) that hasn't
-- been specified yet. Do not extend this view with an amount-mismatch column without
-- that answer; it would be a guess.
-- ----------------------------------------------------------------------------
create view public.v_department_audit_variance with (security_invoker = true) as
select
  e.id as entry_id,
  e.ubbl_number,
  e.main_number,
  e.department_id,
  e.budget_head_id,
  e.vendor_id,
  e.date,
  e.amount,
  e.variance_reason,
  e.status_id,
  e.audit_status_id,
  'main_number_missing'::text as variance_type
from public.entries e
where e.is_void = false
  and e.main_number is null;

grant select on
  public.v_entry_enriched,
  public.v_budget_vs_actual,
  public.v_vendor_spend,
  public.v_zone_spend,
  public.v_department_audit_variance
to authenticated;
