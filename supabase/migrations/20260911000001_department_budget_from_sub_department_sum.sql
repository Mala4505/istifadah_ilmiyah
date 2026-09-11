-- Final departmental budget import (2026-09-11): the user's handed-over
-- "Final_System_Budget.xlsx" is sub-department-grained only (42 departments,
-- 235 sub-department line items) and explicitly wants a department's budget
-- to always equal the sum of its sub-departments' budgets in Reports, rather
-- than being a separately-imported figure that can drift out of sync.
--
-- v_department_budget_vs_actual (created 20260822000002, made event-scoped
-- by 20260822000007) previously read its budget_amount from
-- department_budget_allocation, which 20260822000001's header deliberately
-- described as "NOT a rollup of the per-head allocations" -- a standalone
-- department-level import that was never actually populated (0 rows as of
-- this migration). This redefines the view to compute budget_amount as
-- sum(latest sub_department_budget_allocation.budget_amount) per
-- (department_id, event_id) instead, mirroring
-- v_sub_department_budget_vs_actual's own latest-snapshot CTE
-- (20260825000006) grouped up one level.
--
-- department_budget_allocation the table, and its import pipeline
-- (lib/import/run-department-budget-import.ts, app/api/import/
-- department-budget/route.ts), are left in place untouched -- no data to
-- lose (0 rows), and removing the route is out of scope for this change.
-- They simply no longer feed this view.
drop view public.v_department_budget_vs_actual;

create view public.v_department_budget_vs_actual with (security_invoker = true) as
with latest_sub_allocation as (
  select distinct on (sba.sub_department_id, sba.event_id)
    sba.sub_department_id, sba.event_id, sba.as_of, sba.budget_amount
  from public.sub_department_budget_allocation sba
  order by sba.sub_department_id, sba.event_id, sba.as_of desc, sba.id desc
),
dept_allocation as (
  select
    sd.department_id,
    lsa.event_id,
    sum(lsa.budget_amount) as budget_amount,
    max(lsa.as_of) as as_of
  from latest_sub_allocation lsa
  join public.sub_department sd on sd.id = lsa.sub_department_id
  group by sd.department_id, lsa.event_id
),
actual_spend as (
  select e.department_id, e.event_id, sum(e.amount) as actual_amount, count(*) as entry_count
  from public.entries e
  where e.is_void = false and e.department_id is not null
  group by e.department_id, e.event_id
),
dept_events as (
  select department_id, event_id from dept_allocation
  union
  select department_id, event_id from actual_spend
)
select
  d.id as department_id,
  d.name as department_name,
  de.event_id,
  da.as_of,
  da.budget_amount,
  coalesce(asp.actual_amount, 0) as actual_amount,
  coalesce(asp.entry_count, 0) as entry_count,
  case
    when da.budget_amount is null or da.budget_amount = 0 then null
    else round(coalesce(asp.actual_amount, 0) / da.budget_amount * 100, 2)
  end as pct_of_budget,
  case
    when da.budget_amount is null or da.budget_amount = 0 then 'no budget set'
    else null
  end as budget_status_note
from dept_events de
join public.department d on d.id = de.department_id
left join dept_allocation da on da.department_id = de.department_id and da.event_id = de.event_id
left join actual_spend asp on asp.department_id = de.department_id and asp.event_id = de.event_id;

grant select on public.v_department_budget_vs_actual to authenticated;
