-- Sub-department actuals: split multi-bill entries by their bill lines.
--
-- Before: actual_spend summed entries.amount by entries.sub_department_id only.
-- An entry whose bills belong to several sub-departments (e.g. one Burhani
-- Hospital reimbursement covering Medicines + Equipments + Labour) has no single
-- sub_department_id, so its whole amount was missing from every sub-department.
--
-- Now, for an entry with NO sub_department_id whose bill lines
-- (public.entry_bill_line, 20261009100000) resolve to TWO OR MORE
-- sub-departments of the entry's own department,
-- entries.amount is shared out in proportion to each sub-department's bill
-- amounts. entries.amount stays the total (the scrape owns it), so the split
-- always adds back up to exactly what the department view counts, even when the
-- export lists a bill twice (2026092749) or adds paise the portal rounded away.
-- Lines in another department's sub-department are ignored (2026092629 carries a
-- Mawaid bill under a Venue Setup UBBL; the portal counts only the Venue Setup one).
--
-- Every other entry is counted exactly as before, by entries.sub_department_id,
-- so a reviewer's choice is never overridden. Columns and their order are
-- unchanged, so readers (lib/reports/surfaces/budget.ts, lib/settings/*) need no
-- change.

create or replace view public.v_sub_department_budget_vs_actual
with (security_invoker = true) as
 with latest_allocation as (
         select distinct on (sba.sub_department_id, sba.event_id) sba.sub_department_id,
            sba.event_id,
            sba.as_of,
            sba.budget_amount
           from sub_department_budget_allocation sba
          order by sba.sub_department_id, sba.event_id, sba.as_of desc, sba.id desc
        ), line_share as (
         -- bill amount per (entry, sub-department), own department only
         select l.entry_id,
            l.sub_department_id,
            sum(l.amount) as line_amount
           from entry_bill_line l
             join entries e on e.id = l.entry_id
             join sub_department sd on sd.id = l.sub_department_id
          where e.is_void = false
            and e.sub_department_id is null   -- a reviewer's single choice always wins
            and sd.department_id = e.department_id
            and l.amount > 0
          group by l.entry_id, l.sub_department_id
        ), split_entries as (
         select line_share.entry_id,
            sum(line_share.line_amount) as total_line_amount
           from line_share
          group by line_share.entry_id
         having count(*) >= 2
        ), attributed as (
         select e.event_id,
            ls.sub_department_id,
            e.id as entry_id,
            e.amount * ls.line_amount / se.total_line_amount as amount
           from entries e
             join split_entries se on se.entry_id = e.id
             join line_share ls on ls.entry_id = e.id
        union all
         select e.event_id,
            e.sub_department_id,
            e.id as entry_id,
            e.amount
           from entries e
          where e.is_void = false
            and e.sub_department_id is not null
            and not exists (select 1 from split_entries se where se.entry_id = e.id)
        ), actual_spend as (
         select attributed.sub_department_id,
            attributed.event_id,
            round(sum(attributed.amount), 2) as actual_amount,
            count(distinct attributed.entry_id) as entry_count
           from attributed
          group by attributed.sub_department_id, attributed.event_id
        ), sub_department_events as (
         select latest_allocation.sub_department_id,
            latest_allocation.event_id
           from latest_allocation
        union
         select actual_spend.sub_department_id,
            actual_spend.event_id
           from actual_spend
        )
 select sd.id as sub_department_id,
    sd.name as sub_department_name,
    sd.department_id,
    d.name as department_name,
    sde.event_id,
    la.as_of,
    la.budget_amount,
    coalesce(asp.actual_amount, (0)::numeric) as actual_amount,
    coalesce(asp.entry_count, (0)::bigint) as entry_count,
        case
            when la.budget_amount is null or la.budget_amount = (0)::numeric then null::numeric
            else round(coalesce(asp.actual_amount, (0)::numeric) / la.budget_amount * (100)::numeric, 2)
        end as pct_of_budget,
        case
            when la.budget_amount is null or la.budget_amount = (0)::numeric then 'no budget set'::text
            else null::text
        end as budget_status_note
   from sub_department_events sde
     join sub_department sd on sd.id = sde.sub_department_id
     join department d on d.id = sd.department_id
     left join latest_allocation la on la.sub_department_id = sde.sub_department_id and la.event_id = sde.event_id
     left join actual_spend asp on asp.sub_department_id = sde.sub_department_id and asp.event_id = sde.event_id;
