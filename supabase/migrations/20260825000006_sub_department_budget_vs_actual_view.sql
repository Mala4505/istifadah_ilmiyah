-- Sub-department feature: budget-vs-actual view, mirroring
-- v_department_budget_vs_actual's current event-scoped shape
-- (20260822000007_reports_export_event_scoping.sql:46-83) exactly, grained
-- per (sub_department_id, event_id).
--
-- Aggregate-view grain pitfall: both CTEs group by the dimension id AND
-- event_id together (not just the dimension id with event_id appended to
-- the SELECT list afterwards) -- otherwise a sub-department active across
-- two events would silently sum both events' figures into one row, and
-- event_id on the output would be decorative rather than a real per-event
-- split. Same union-of-sources shape as v_department_budget_vs_actual too:
-- the base set of (sub_department_id, event_id) pairs is the union of
-- whichever of sub_department_budget_allocation/entries actually has a row
-- for that pair -- not a cross join against every sub-department, and not
-- sourced from event_sub_department membership (membership completeness is
-- a separate concern this view doesn't own).
create view public.v_sub_department_budget_vs_actual with (security_invoker = true) as
with latest_allocation as (
  select distinct on (sba.sub_department_id, sba.event_id)
    sba.sub_department_id, sba.event_id, sba.as_of, sba.budget_amount
  from public.sub_department_budget_allocation sba
  order by sba.sub_department_id, sba.event_id, sba.as_of desc, sba.id desc
),
actual_spend as (
  select e.sub_department_id, e.event_id, sum(e.amount) as actual_amount, count(*) as entry_count
  from public.entries e
  where e.is_void = false and e.sub_department_id is not null
  group by e.sub_department_id, e.event_id
),
sub_department_events as (
  select sub_department_id, event_id from latest_allocation
  union
  select sub_department_id, event_id from actual_spend
)
select
  sd.id as sub_department_id,
  sd.name as sub_department_name,
  sd.department_id,
  d.name as department_name,
  sde.event_id,
  la.as_of,
  la.budget_amount,
  coalesce(asp.actual_amount, 0) as actual_amount,
  coalesce(asp.entry_count, 0) as entry_count,
  case when la.budget_amount is null or la.budget_amount = 0 then null
       else round(coalesce(asp.actual_amount, 0) / la.budget_amount * 100, 2) end as pct_of_budget,
  case when la.budget_amount is null or la.budget_amount = 0 then 'no budget set' else null end as budget_status_note
from sub_department_events sde
join public.sub_department sd on sd.id = sde.sub_department_id
join public.department d on d.id = sd.department_id
left join latest_allocation la on la.sub_department_id = sde.sub_department_id and la.event_id = sde.event_id
left join actual_spend asp on asp.sub_department_id = sde.sub_department_id and asp.event_id = sde.event_id;

grant select on public.v_sub_department_budget_vs_actual to authenticated;
