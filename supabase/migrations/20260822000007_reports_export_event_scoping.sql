-- Phase 6 Step 2, Stream D (docs/event-scoping-and-review-fixes-plan.md §1):
-- the six reporting views the /reports screen and the status-export path
-- read from all aggregate `entries` (and, for the budget views,
-- `budget_allocation`/`department_budget_allocation`) without any notion of
-- which event a row belongs to. A reviewer on 1449 H would otherwise see
-- 1448 H's entries baked into the same totals.
--
-- Same join-vs-denormalize / filter-site decision Stream A already made for
-- v_review_queue (20260822000006's header): event is reachable for free by
-- joining through `entries.event_id` (direct) or, for v_open_issues,
-- through whichever of reconciliation_exception's three nullable FKs
-- (entry_id / document_extraction_id / import_batch_id) resolves first --
-- so nothing here is denormalized speculatively. Every view below exposes
-- `event_id` as a plain output column; filtering happens at the query site
-- (app/(app)/reports/page.tsx, lib/export/*.ts), not in the view's WHERE
-- clause, so these views stay reusable for future cross-event reporting.
--
-- Every aggregate view (the group-by ones) now groups by event_id too, so a
-- vendor/zone/budget-head with activity in two events gets two rows instead
-- of one row silently summing across both. Column lists change (event_id is
-- a genuinely new column, not just appended in every case), so views are
-- dropped and recreated rather than CREATE OR REPLACE VIEW'd throughout, for
-- clarity -- matching the precedent 20260811000004's header sets for exactly
-- this situation. CREATE OR REPLACE VIEW does not preserve dependent grants
-- across a drop, so every view re-grants select explicitly below.

drop view if exists public.v_department_budget_vs_actual;
drop view if exists public.v_budget_vs_actual;
drop view if exists public.v_vendor_spend;
drop view if exists public.v_zone_spend;
drop view if exists public.v_hub_status_ageing;
drop view if exists public.v_open_issues;

-- ----------------------------------------------------------------------------
-- v_department_budget_vs_actual -- base definition: 20260822000002. Now one
-- row per (department, event) instead of one row per department. The base
-- set of (department_id, event_id) pairs is the union of whichever of
-- department_budget_allocation/entries actually has a row for that pair --
-- NOT a cross join against every department, and NOT sourced from
-- event_department membership, because membership completeness for a given
-- (department, event) is a separate concern (see 20260822000005's header on
-- event_budget_head) this stream does not own; deriving the grain from the
-- two tables that already carry event_id directly can't silently drop real
-- budget/actual data behind an incomplete membership row.
-- ----------------------------------------------------------------------------
create view public.v_department_budget_vs_actual with (security_invoker = true) as
with latest_allocation as (
  select distinct on (dba.department_id, dba.event_id)
    dba.department_id, dba.event_id, dba.as_of, dba.budget_amount
  from public.department_budget_allocation dba
  order by dba.department_id, dba.event_id, dba.as_of desc, dba.id desc
),
actual_spend as (
  select e.department_id, e.event_id, sum(e.amount) as actual_amount, count(*) as entry_count
  from public.entries e
  where e.is_void = false and e.department_id is not null
  group by e.department_id, e.event_id
),
dept_events as (
  select department_id, event_id from latest_allocation
  union
  select department_id, event_id from actual_spend
)
select
  d.id as department_id,
  d.name as department_name,
  de.event_id,
  la.as_of,
  la.budget_amount,
  coalesce(asp.actual_amount, 0) as actual_amount,
  coalesce(asp.entry_count, 0) as entry_count,
  case
    when la.budget_amount is null or la.budget_amount = 0 then null
    else round(coalesce(asp.actual_amount, 0) / la.budget_amount * 100, 2)
  end as pct_of_budget,
  case
    when la.budget_amount is null or la.budget_amount = 0 then 'no budget set'
    else null
  end as budget_status_note
from dept_events de
join public.department d on d.id = de.department_id
left join latest_allocation la on la.department_id = de.department_id and la.event_id = de.event_id
left join actual_spend asp on asp.department_id = de.department_id and asp.event_id = de.event_id;

-- ----------------------------------------------------------------------------
-- v_budget_vs_actual -- base definition: 20260811000004. Same union-of-
-- sources shape as v_department_budget_vs_actual above, one row per
-- (budget_head, event).
-- ----------------------------------------------------------------------------
create view public.v_budget_vs_actual with (security_invoker = true) as
with latest_allocation as (
  select distinct on (ba.budget_head_id, ba.event_id)
    ba.budget_head_id, ba.event_id, ba.as_of, ba.request_amount, ba.approved_amount,
    ba.utilised_amount, ba.balance_amount
  from public.budget_allocation ba
  order by ba.budget_head_id, ba.event_id, ba.as_of desc, ba.id desc
),
actual_spend as (
  select e.budget_head_id, e.event_id, sum(e.amount) as actual_amount, count(*) as entry_count
  from public.entries e
  where e.is_void = false and e.budget_head_id is not null
  group by e.budget_head_id, e.event_id
),
head_events as (
  select budget_head_id, event_id from latest_allocation
  union
  select budget_head_id, event_id from actual_spend
)
select
  bh.id as budget_head_id,
  bh.raw_label,
  bh.short_label,
  bh.department_id,
  he.event_id,
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
from head_events he
join public.budget_head bh on bh.id = he.budget_head_id
left join latest_allocation la on la.budget_head_id = he.budget_head_id and la.event_id = he.event_id
left join actual_spend asp on asp.budget_head_id = he.budget_head_id and asp.event_id = he.event_id;

-- ----------------------------------------------------------------------------
-- v_vendor_spend -- base definition: 20260821000002 (the entry_docs-
-- deduplicated fix). vendor identity stays global/shared (doc §1.2's shared
-- list -- vendor is explicitly NOT event-scoped), but the entries a vendor's
-- totals are summed from ARE event-scoped, so grouping adds event_id: a
-- vendor active across two events gets two rows, one per event. The reports
-- page already filters zero-activity rows out client-side
-- (`vendorRows.filter(r => r.entry_count > 0)`), so a vendor with zero
-- entries in the selected event simply drops out at the query-site filter,
-- same as it always effectively has.
-- ----------------------------------------------------------------------------
create view public.v_vendor_spend with (security_invoker = true) as
with entry_docs as (
  select distinct coalesce(de.entry_id, sd.entry_id) as entry_id
  from public.source_document sd
  left join public.document_extraction de
    on de.source_document_id = sd.id
   and de.entry_id is not null
  where coalesce(de.entry_id, sd.entry_id) is not null
)
select
  v.id as vendor_id,
  v.display_name,
  v.normalized_name,
  v.is_confirmed,
  e.event_id,
  count(e.id) as entry_count,
  sum(e.amount) as total_amount,
  min(e.date) as first_entry_date,
  max(e.date) as last_entry_date,
  count(distinct ed.entry_id) as entries_with_documents,
  case when count(e.id) = 0 then null
       else round(count(distinct ed.entry_id)::numeric / count(e.id) * 100, 2)
  end as document_coverage_pct
from public.vendor v
left join public.entries e on e.vendor_id = v.id and e.is_void = false
left join entry_docs ed on ed.entry_id = e.id
group by v.id, v.display_name, v.normalized_name, v.is_confirmed, e.event_id;

-- ----------------------------------------------------------------------------
-- v_zone_spend -- base definition: 20260811000004. FROM is entries (not
-- zone), so a zone with zero entries in any event never appeared before
-- either -- adding e.event_id to the group-by is the only change needed.
-- ----------------------------------------------------------------------------
create view public.v_zone_spend with (security_invoker = true) as
select
  z.id as zone_id,
  coalesce(z.name, 'unassigned') as zone_name,
  z.zone_number,
  e.department_id,
  e.event_id,
  count(e.id) as entry_count,
  sum(e.amount) as total_amount
from public.entries e
left join public.zone z on z.id = e.zone_id
where e.is_void = false
group by z.id, z.name, z.zone_number, e.department_id, e.event_id;

-- ----------------------------------------------------------------------------
-- v_hub_status_ageing -- base definition: 20260814000007. One row per entry
-- already (no group-by) -- event_id is entries.event_id, added straight to
-- the select list.
-- ----------------------------------------------------------------------------
create view public.v_hub_status_ageing with (security_invoker = true) as
select
  e.id as entry_id,
  e.department_id,
  e.event_id,
  e.ubbl_number,
  e.hub_status_id,
  hs.code as hub_status_code,
  hs.label as hub_status_label,
  e.hub_status_changed_at,
  extract(day from now() - coalesce(e.hub_status_changed_at, e.created_at))::int as days_in_status,
  case
    when extract(day from now() - coalesce(e.hub_status_changed_at, e.created_at)) <= 2 then '0-2'
    when extract(day from now() - coalesce(e.hub_status_changed_at, e.created_at)) <= 7 then '3-7'
    else '8+'
  end as age_bucket
from public.entries e
join public.hub_status hs on hs.id = e.hub_status_id
where e.is_void = false
  and hs.code in ('awaiting_verification', 'awaiting_validation');

-- ----------------------------------------------------------------------------
-- v_open_issues -- base definition: 20260814000007. Neither
-- reconciliation_exception nor flags carries event_id directly (doc §1.2:
-- both "inherit event via its parent, no column of its own"). Best-effort
-- resolution or of whichever parent link is populated:
--   reconciliation_exception -> entries.event_id (via entry_id), else
--                                source_document.event_id (via
--                                document_extraction_id), else
--                                import_batch.event_id (via import_batch_id)
--   flags                    -> entries.event_id (via entry_id) -- flags has
--                                no document_extraction_id/import_batch_id
--                                to fall back through (20260808000025)
-- A vendor-level flag (entry_id null, e.g. vendor_splitting/tds_threshold --
-- 20260814000003) has no traceable event and gets a null event_id; filtered
-- to one event at the query site, it drops out of that event's digest. That
-- matches this pass's scope (single-event reports, no cross-event mode,
-- per the plan's explicit §1.6 deferral) -- a cross-department/cross-event
-- vendor flag has no single event to attribute to in the first place.
-- ----------------------------------------------------------------------------
create view public.v_open_issues with (security_invoker = true) as
select * from (
  select
    'reconciliation_exception'::text as source_table,
    re.id,
    re.entry_id,
    re.exception_type as issue_type,
    re.severity,
    re.amount_at_risk,
    re.description,
    re.status,
    re.created_at,
    coalesce(re_e.event_id, re_sd.event_id, re_ib.event_id) as event_id
  from public.reconciliation_exception re
  left join public.entries re_e on re_e.id = re.entry_id
  left join public.document_extraction re_de on re_de.id = re.document_extraction_id
  left join public.source_document re_sd on re_sd.id = re_de.source_document_id
  left join public.import_batch re_ib on re_ib.id = re.import_batch_id
  where re.status = 'open'
  union all
  select
    'flags'::text as source_table,
    f.id,
    f.entry_id,
    f.flag_type as issue_type,
    f.severity,
    f.amount_at_risk,
    f.description,
    f.status,
    f.created_at,
    f_e.event_id
  from public.flags f
  left join public.entries f_e on f_e.id = f.entry_id
  where f.status = 'open'
) combined
-- Postgres forbids expressions in a UNION's ORDER BY (only output column names/ordinals
-- are allowed there) -- wrapped in a subquery so the CASE expression is legal here.
order by
  case severity when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end,
  amount_at_risk desc nulls last;

-- A view is its own object, distinct from its base tables -- the broad
-- `grant select ... on all tables in schema public` in 20260808000026_rls_policies.sql
-- predates every one of these views. DROP VIEW removes any grant that existed on the
-- old object, so every view re-grants select explicitly here.
grant select on
  public.v_department_budget_vs_actual,
  public.v_budget_vs_actual,
  public.v_vendor_spend,
  public.v_zone_spend,
  public.v_hub_status_ageing,
  public.v_open_issues
to authenticated;
