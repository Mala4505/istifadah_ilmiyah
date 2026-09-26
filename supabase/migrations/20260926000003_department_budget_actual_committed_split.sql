-- Split v_department_budget_vs_actual's actual_amount into a paid/committed
-- pair for the on-screen Budget & Spend report (operator request, 2026-09-26).
--
-- WHY: actual_amount today is sum(entries.amount) across every non-void
-- entry regardless of status, so a department can look "fully spent"
-- against its budget while most of that amount is really still moving
-- through the pre-payment workflow (subject_to_approval, not_verified,
-- awaiting_verification, received, returned, verification_stage_1..4,
-- good_for_submission) and hasn't actually left the bank yet. Only 'paid'
-- and 'tax_invoice_upload_pending_paid' represent money genuinely already
-- disbursed -- the latter is paid in substance, just waiting on a
-- tax-invoice document upload, a paperwork step rather than a payment step
-- (see 20260907000006_curate_verification_stage_statuses.sql's final
-- ordering, where tax_invoice_upload_pending_paid sits directly before
-- paid). Everything else is a pre-payment stage: money recorded/promised
-- but not yet paid out, i.e. "committed" against the budget rather than
-- spent.
--
-- actual_paid_amount + committed_amount therefore always reconciles back to
-- the existing actual_amount for a given (department, event) -- every
-- non-void entry falls into exactly one of the two buckets. actual_amount
-- itself is left untouched (existing PDF export and any other consumer
-- keep reading it exactly as before); the split is additive.
--
-- Status is resolved the same way the rest of the app reads it: join
-- entry_status on entries.status_id (the standard `st.id = e.status_id`
-- shape used throughout, e.g. 20260825007_entry_enriched_sub_department.sql
-- and 20260822000011_analytics_event_scoping.sql), falling back to
-- entries.status_raw for any entry whose status_id is null (unmapped/manual
-- rows never linked to the entry_status vocabulary).
--
-- balance_amount = budget_amount - actual_paid_amount - committed_amount,
-- null exactly when budget_amount is null (no allocation on record), same
-- posture as pct_of_budget below it. pct_paid_of_budget / pct_committed_of_budget
-- follow pct_of_budget's own null-on-no-budget / round-to-2-decimals
-- convention.
--
-- This is purely additive to the view added by 20260911000001
-- (department_budget_from_sub_department_sum.sql, current live definition)
-- -- CTEs and join shape are reproduced unchanged; only the actual_spend CTE
-- gains the paid/committed split and the final select gains the new
-- columns. PDF export (lib/reports/budget-utilization-pdf.ts) is untouched
-- and keeps reading only budget_amount/actual_amount/pct_of_budget.
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
  select
    e.department_id,
    e.event_id,
    sum(e.amount) as actual_amount,
    count(*) as entry_count,
    sum(
      case
        when coalesce(es.code, e.status_raw) in ('paid', 'tax_invoice_upload_pending_paid')
          then e.amount
        else 0
      end
    ) as actual_paid_amount,
    sum(
      case
        when coalesce(es.code, e.status_raw) in ('paid', 'tax_invoice_upload_pending_paid')
          then 0
        else e.amount
      end
    ) as committed_amount
  from public.entries e
  left join public.entry_status es on es.id = e.status_id
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
  coalesce(asp.actual_paid_amount, 0) as actual_paid_amount,
  coalesce(asp.committed_amount, 0) as committed_amount,
  case
    when da.budget_amount is null then null
    else da.budget_amount - coalesce(asp.actual_paid_amount, 0) - coalesce(asp.committed_amount, 0)
  end as balance_amount,
  coalesce(asp.entry_count, 0) as entry_count,
  case
    when da.budget_amount is null or da.budget_amount = 0 then null
    else round(coalesce(asp.actual_amount, 0) / da.budget_amount * 100, 2)
  end as pct_of_budget,
  case
    when da.budget_amount is null or da.budget_amount = 0 then null
    else round(coalesce(asp.actual_paid_amount, 0) / da.budget_amount * 100, 2)
  end as pct_paid_of_budget,
  case
    when da.budget_amount is null or da.budget_amount = 0 then null
    else round(coalesce(asp.committed_amount, 0) / da.budget_amount * 100, 2)
  end as pct_committed_of_budget,
  case
    when da.budget_amount is null or da.budget_amount = 0 then 'no budget set'
    else null
  end as budget_status_note
from dept_events de
join public.department d on d.id = de.department_id
left join dept_allocation da on da.department_id = de.department_id and da.event_id = de.event_id
left join actual_spend asp on asp.department_id = de.department_id and asp.event_id = de.event_id;

grant select on public.v_department_budget_vs_actual to authenticated;
