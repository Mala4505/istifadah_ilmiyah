-- Review-page-redesign plan §11 -- v_department_budget_vs_actual. Mirrors
-- v_budget_vs_actual's exact shape (20260811000004_reporting_views_update.sql:
-- 90-126): latest department_budget_allocation row per department, left-joined
-- against sum(entries.amount) for that department. Same null-handling
-- convention -- 'no budget set' status note instead of a misleading -100%
-- when budget_amount is null/0 (the department_budget_allocation analog of
-- v_budget_vs_actual's 'no approved budget' / approved_amount = 0 case).
--
-- Deliberately NOT joined against/reusing budget_head or v_budget_vs_actual --
-- §11 is explicit this is a separate, department-grained parallel system, not
-- a rollup of the per-head one.
create view public.v_department_budget_vs_actual with (security_invoker = true) as
with latest_allocation as (
  select distinct on (dba.department_id)
    dba.department_id, dba.as_of, dba.budget_amount
  from public.department_budget_allocation dba
  order by dba.department_id, dba.as_of desc, dba.id desc
),
actual_spend as (
  select e.department_id, sum(e.amount) as actual_amount, count(*) as entry_count
  from public.entries e
  where e.is_void = false and e.department_id is not null
  group by e.department_id
)
select
  d.id as department_id,
  d.name as department_name,
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
from public.department d
left join latest_allocation la on la.department_id = d.id
left join actual_spend asp on asp.department_id = d.id;

grant select on public.v_department_budget_vs_actual to authenticated;
