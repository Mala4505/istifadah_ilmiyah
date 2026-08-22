-- docs/pre-deploy-findings-and-plan.md §6.1: ten of the app's query sites filter by the
-- selected event; v_entry_status_counts and the four analytics views (v_compliance_summary,
-- v_vendor_concentration, v_spend_by_family, v_rate_benchmark) were never touched by Phase 6
-- and have no event_id column at all -- invisible today because only one event exists, but
-- the Dashboard and Reports would silently sum across years the day 1449 H is created.
--
-- Same drop-and-recreate / filter-at-query-site approach as 20260822000007: event_id is
-- exposed as a plain output column, filtering happens at the query site, and every
-- group-by aggregate adds event_id to its GROUP BY so an entity active across two events
-- gets two rows instead of one silently-summed row. DROP VIEW loses grants, so every view
-- re-grants select to authenticated below.
--
-- How event_id is reachable per view:
--   v_entry_status_counts -- entries-based (three unioned selects, one per status
--     dimension), event_id is entries.event_id directly, added to both the select list
--     and each branch's GROUP BY.
--   v_compliance_summary -- one row per open flag (no group-by). flags carries no
--     event_id of its own (20260808000025); resolved via entries.event_id through the
--     existing `left join entries e on e.id = f.entry_id` this view already has for
--     department_id. A vendor-level flag (entry_id null, e.g. vendor_cluster) gets a
--     null event_id here, same as v_open_issues already documents for that case.
--   v_vendor_concentration -- vendor identity stays global (same reasoning
--     20260822000007 gave for v_vendor_spend), but both CTEs that feed the final select
--     are now per (vendor, event): vendor_totals via entries.event_id directly (entries
--     is already joined for the spend sum), vendor_flags via a new
--     `left join entries fe on fe.id = f.entry_id` (flags has no event_id of its own,
--     same resolution as v_compliance_summary above). The final join matches on
--     vendor_id AND event_id (`is not distinct from`, since either side's event_id can be
--     null) so a vendor-level flag with no resolvable event never gets attributed to one
--     of the vendor's real event rows. pct_of_total_spend's window now partitions by
--     event_id too -- otherwise a per-event row would be divided by a cross-event total,
--     which is exactly the kind of silent cross-year mixing this migration exists to stop.
--   v_spend_by_family / v_rate_benchmark -- neither item_family nor rate_reference
--     carries event_id; rate_reference.entry_id (nullable, 20260808000024) is the only
--     path to an event, via a new `left join entries e on e.id = rr.entry_id`. An
--     observation with no linked entry (a rate captured before entry-matching, or never
--     matched at all) gets a null event_id and groups into a "no event" bucket per
--     family/benchmark row, rather than being silently dropped -- consistent with the
--     best-effort-resolution-or-null approach used throughout this event-scoping pass.
--
-- Also folding in the doc's related note: "Worth adding event_id to v_entry_enriched so
-- every surface can use the same pattern" (today /entries and /export scope themselves by
-- re-implementing the cookie-reading logic client-side, because v_entry_enriched has no
-- event_id to filter on). Base definition: 20260821000002 (the entry_id-coalesce fix,
-- last migration-tracked version) -- only the new event_id output column is added, no
-- other column changes, so this one keeps `create or replace view` rather than drop+create
-- (matching 20260821000002's own note that create or replace does not revoke grants when
-- the column list is only extended at the end).

drop view if exists public.v_entry_status_counts;
drop view if exists public.v_compliance_summary;
drop view if exists public.v_vendor_concentration;
drop view if exists public.v_spend_by_family;
drop view if exists public.v_rate_benchmark;

-- ----------------------------------------------------------------------------
-- v_entry_status_counts -- base definition: 20260817000001. One row per
-- (dimension, status value, event) instead of per (dimension, status value).
-- ----------------------------------------------------------------------------
create view public.v_entry_status_counts with (security_invoker = true) as
select
  'status'::text as dimension,
  e.status_id,
  coalesce(st.code, 'not_set') as status_code,
  coalesce(st.label, 'Not set') as status_label,
  coalesce(st.sort_order, 999) as sort_order,
  e.event_id,
  count(*) as entry_count
from public.entries e
left join public.entry_status st on st.id = e.status_id
group by e.status_id, st.code, st.label, st.sort_order, e.event_id
union all
select
  'audit_status'::text as dimension,
  e.audit_status_id,
  coalesce(ast.code, 'not_set') as status_code,
  coalesce(ast.label, 'Not set') as status_label,
  coalesce(ast.sort_order, 999) as sort_order,
  e.event_id,
  count(*) as entry_count
from public.entries e
left join public.entry_status ast on ast.id = e.audit_status_id
group by e.audit_status_id, ast.code, ast.label, ast.sort_order, e.event_id
union all
select
  'hub_status'::text as dimension,
  e.hub_status_id,
  hs.code as status_code,
  hs.label as status_label,
  hs.sort_order,
  e.event_id,
  count(*) as entry_count
from public.entries e
join public.hub_status hs on hs.id = e.hub_status_id
group by e.hub_status_id, hs.code, hs.label, hs.sort_order, e.event_id;

-- ----------------------------------------------------------------------------
-- v_compliance_summary -- base definition: 20260814000007. One row per open flag
-- already (no group-by); event_id resolved via the existing entries join.
-- ----------------------------------------------------------------------------
create view public.v_compliance_summary with (security_invoker = true) as
select
  f.id,
  f.flag_type,
  f.severity,
  f.description,
  f.amount_at_risk,
  f.status,
  f.entry_id,
  e.event_id,
  f.vendor_id,
  v.display_name as vendor_display_name,
  e.department_id,
  d.name as department_name,
  f.created_at,
  f.last_detected_at,
  f.related_entry_ids
from public.flags f
left join public.vendor v on v.id = f.vendor_id
left join public.entries e on e.id = f.entry_id
left join public.department d on d.id = e.department_id
where f.status = 'open'
order by
  case f.severity when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end,
  f.amount_at_risk desc nulls last;

-- ----------------------------------------------------------------------------
-- v_vendor_concentration -- base definition: 20260814000007. Now one row per
-- (vendor, event). See header for how each CTE resolves event_id and why the
-- final join matches on (vendor_id, event_id) rather than vendor_id alone.
-- ----------------------------------------------------------------------------
create view public.v_vendor_concentration with (security_invoker = true) as
with vendor_totals as (
  select
    v.id as vendor_id,
    v.display_name,
    v.normalized_name,
    v.is_confirmed,
    e.event_id,
    count(e.id) as entry_count,
    sum(e.amount) as total_amount
  from public.vendor v
  left join public.entries e on e.vendor_id = v.id and e.is_void = false
  group by v.id, v.display_name, v.normalized_name, v.is_confirmed, e.event_id
),
vendor_flags as (
  select
    f.vendor_id,
    fe.event_id,
    count(*) as open_flag_count,
    sum(f.amount_at_risk) as open_flag_amount_at_risk
  from public.flags f
  left join public.entries fe on fe.id = f.entry_id
  where f.status = 'open' and f.vendor_id is not null
  group by f.vendor_id, fe.event_id
)
select
  vt.vendor_id,
  vt.display_name,
  vt.normalized_name,
  vt.is_confirmed,
  vt.event_id,
  vt.entry_count,
  vt.total_amount,
  coalesce(vf.open_flag_count, 0) as open_flag_count,
  vf.open_flag_amount_at_risk,
  -- sum(...) over (partition by event_id) is the per-event (or, under RLS, "everything
  -- this caller can see in this event") denominator -- partitioned so a per-event row is
  -- never divided by a cross-event total. nullif guards the same would-be division by
  -- zero as before.
  round(
    coalesce(vt.total_amount, 0)
    / nullif(sum(coalesce(vt.total_amount, 0)) over (partition by vt.event_id), 0) * 100,
    2
  ) as pct_of_total_spend
from vendor_totals vt
left join vendor_flags vf
  on vf.vendor_id = vt.vendor_id and vf.event_id is not distinct from vt.event_id;

-- ----------------------------------------------------------------------------
-- v_spend_by_family -- base definition: 20260814000007. Now one row per
-- (item_family, event); event_id resolved via a new join to entries through
-- rate_reference.entry_id (nullable -- see header).
-- ----------------------------------------------------------------------------
create view public.v_spend_by_family with (security_invoker = true) as
select
  fam.id as item_family_id,
  fam.family_key,
  fam.label,
  fam.default_unit,
  fam.is_confirmed,
  e.event_id,
  coalesce(sum(rr.net_rate * coalesce(rr.quantity, 1)), 0) as total_spend,
  count(rr.id) as observation_count,
  count(distinct rr.vendor_id) as vendor_count
from public.item_family fam
left join public.rate_reference rr
  on rr.item_family_id = fam.id and rr.is_comparable = true
left join public.entries e on e.id = rr.entry_id
group by fam.id, fam.family_key, fam.label, fam.default_unit, fam.is_confirmed, e.event_id;

-- ----------------------------------------------------------------------------
-- v_rate_benchmark -- base definition: 20260814000007. Now one row per
-- (item_family, unit_normalized, event); event_id resolved the same way as
-- v_spend_by_family above.
-- ----------------------------------------------------------------------------
create view public.v_rate_benchmark with (security_invoker = true) as
select
  rr.item_family_id,
  fam.family_key,
  fam.label as family_label,
  rr.unit_normalized,
  e.event_id,
  percentile_cont(0.5) within group (order by rr.net_rate) as median_rate,
  count(*) as observation_count,
  count(distinct rr.vendor_id) as vendor_count,
  min(rr.net_rate) as min_rate,
  max(rr.net_rate) as max_rate
from public.rate_reference rr
join public.item_family fam on fam.id = rr.item_family_id
left join public.entries e on e.id = rr.entry_id
where rr.is_comparable = true
group by rr.item_family_id, fam.family_key, fam.label, rr.unit_normalized, e.event_id;

-- ----------------------------------------------------------------------------
-- v_entry_enriched -- base definition: 20260821000002 (last migration-tracked
-- version). Only the new event_id output column is added; every other column
-- and join is unchanged, so `create or replace view` is used (not drop+create)
-- per 20260821000002's own note that this does not revoke existing grants when
-- the column list is only extended at the end. event_id genuinely has to go at
-- the very end of the select list (after document_count, not grouped next to
-- e.import_batch_id where it would read more naturally) -- CREATE OR REPLACE
-- VIEW only tolerates appending columns after the existing last column;
-- inserting it any earlier shifts created_at/updated_at's positions, which
-- Postgres treats as renaming them and refuses (confirmed by trying it first).
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
  coalesce(doc.document_count, 0) as document_count,
  e.event_id
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

-- A view is its own object, distinct from its base tables -- the broad
-- `grant select ... on all tables in schema public` in 20260808000026_rls_policies.sql
-- predates every one of these views. DROP VIEW removes any grant that existed on the
-- old object, so every dropped-and-recreated view re-grants select explicitly here.
-- v_entry_enriched is CREATE OR REPLACE'd above (grant survives), but it's harmless and
-- keeps this block a complete, self-contained list of every view this migration touches.
grant select on
  public.v_entry_status_counts,
  public.v_compliance_summary,
  public.v_vendor_concentration,
  public.v_spend_by_family,
  public.v_rate_benchmark,
  public.v_entry_enriched
to authenticated;
