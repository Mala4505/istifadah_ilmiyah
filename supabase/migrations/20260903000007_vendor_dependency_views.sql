-- reporting-blueprint.md §3 Family B, Phase Five: "Procurement gets a real
-- analytical surface." Three new views for B-03/B-04/B-05:
--
--   v_department_vendor_dependency -- B-03. One row per (department, event):
--     the department's TOP vendor by spend within that department, that
--     vendor's spend, the department's total spend, how many distinct
--     vendors it used, and the top vendor's share of department spend. The
--     finding (share > 50%) is applied at the query/app site, not baked into
--     the view -- the view exposes the number, the app draws the line, same
--     separation v_rate_observation (20260903000002) uses for its median.
--     "Top vendor" is a row_number()-ranked CTE, not a correlated subquery,
--     per this repo's SQL convention; ties broken by vendor_id ascending so
--     the ranking is deterministic.
--
--   v_vendor_exclusivity -- B-04. One row per (vendor, event): how many
--     DISTINCT departments that vendor billed, its total spend across all of
--     them, and entry count. `department_name` is populated only when
--     distinct_department_count = 1 (the one department an exclusive vendor
--     serves) -- for a vendor spanning more than one department the column
--     is null, since "the" department wouldn't mean anything there. The
--     finding (distinct_department_count = 1, ranked by spend) and any
--     materiality cut (e.g. top-decile spend) are both app-side.
--
--   v_vendor_first_bill -- B-05. One row per (vendor, event): the date and
--     amount of that vendor's FIRST entry this event, the largest amount on
--     any of their entries this event, total spend, entry count, and --
--     critically -- the event's own earliest entry date so the app (or this
--     view, precomputed below as `is_new_mid_event`) can tell a vendor whose
--     first bill happens to be the earliest row in the whole corpus (not a
--     real "new mid-event" story) apart from one who genuinely first
--     appears after the event was already under way. `opening_bill_is_largest`
--     precomputes the other half of the finding (first_entry_amount =
--     max_entry_amount). The blueprint's finding is
--     `opening_bill_is_largest AND is_new_mid_event` together -- both flags
--     are exposed so the app can filter/sort on either independently, same
--     reasoning v_rate_observation precomputes overpayment_amount rather
--     than making every caller redo the median comparison.
--
-- security_invoker = true on all three (every view in this codebase runs as
-- the calling user so base-table RLS applies). Each is a new object the
-- broad `grant select on all tables in schema public` (20260808000026)
-- predates, so each needs its own explicit grant below. event_id is a plain
-- output column on every one, present in every GROUP BY / PARTITION BY
-- (20260822000011's convention) -- filtering by event happens at the query
-- site, and per Observation 25 in this repo's own skill-observation log,
-- these are aggregate views, so event_id had to change the GROUP BY grain
-- (one row per entity-per-event), not just get appended to the SELECT list.
--
-- Department-leak note: `vendor` is staff-wide SELECT with no department
-- scoping (deliberate). `entries` IS department-scoped by RLS
-- (`can_see_department`, 20260808000002/20260808000026), and every one of
-- these three views is built directly from `entries`. So: a department-
-- scoped reviewer sees `v_department_vendor_dependency` rows only for the
-- department(s) they can see (the view's grain is per-department, so
-- other departments' rows simply don't appear). For `v_vendor_exclusivity`
-- and `v_vendor_first_bill` -- both keyed by vendor, a staff-wide identity --
-- a department-scoped reviewer still sees one row per vendor, but every
-- aggregate on it (total_spend, entry_count, distinct_department_count,
-- first/max entry figures) is computed ONLY from the entries that
-- reviewer's RLS grant lets them see, not the vendor's true organisation-
-- wide totals. A vendor who looks "exclusive to my department" or "new to
-- me this event" under this view may in fact serve other departments too,
-- or have billed earlier in a department this reviewer cannot see. This is
-- the same documented property `v_vendor_spend` already has.

-- ----------------------------------------------------------------------------
-- v_department_vendor_dependency -- B-03
-- ----------------------------------------------------------------------------
create view public.v_department_vendor_dependency with (security_invoker = true) as
with dept_vendor_spend as (
  select
    e.department_id,
    d.name as department_name,
    e.event_id,
    e.vendor_id,
    v.display_name as vendor_display_name,
    sum(e.amount) as vendor_spend
  from public.entries e
  join public.department d on d.id = e.department_id
  join public.vendor v on v.id = e.vendor_id
  where e.is_void = false
    and e.department_id is not null
    and e.vendor_id is not null
  group by e.department_id, d.name, e.event_id, e.vendor_id, v.display_name
),
dept_total as (
  select
    department_id,
    event_id,
    sum(vendor_spend) as department_total_spend,
    count(distinct vendor_id) as vendor_count
  from dept_vendor_spend
  group by department_id, event_id
),
ranked as (
  select
    dvs.department_id,
    dvs.department_name,
    dvs.event_id,
    dvs.vendor_id,
    dvs.vendor_display_name,
    dvs.vendor_spend,
    dt.department_total_spend,
    dt.vendor_count,
    row_number() over (
      partition by dvs.department_id, dvs.event_id
      order by dvs.vendor_spend desc, dvs.vendor_id asc
    ) as rn
  from dept_vendor_spend dvs
  join dept_total dt
    on dt.department_id = dvs.department_id
   and dt.event_id = dvs.event_id
)
select
  department_id,
  department_name,
  event_id,
  vendor_id as top_vendor_id,
  vendor_display_name as top_vendor_display_name,
  vendor_spend as top_vendor_spend,
  department_total_spend,
  vendor_count,
  case
    when department_total_spend > 0
    then round((vendor_spend / department_total_spend) * 100, 2)
    else null
  end as top_vendor_share_pct
from ranked
where rn = 1;

-- ----------------------------------------------------------------------------
-- v_vendor_exclusivity -- B-04
-- ----------------------------------------------------------------------------
create view public.v_vendor_exclusivity with (security_invoker = true) as
select
  e.vendor_id,
  v.display_name as vendor_display_name,
  e.event_id,
  count(distinct e.department_id) as distinct_department_count,
  -- Both meaningful only when distinct_department_count = 1 -- the one
  -- department an exclusive vendor serves, exposed as both id (for a drill-
  -- through link) and name. Null for a multi-department vendor rather than
  -- picking an arbitrary one of several.
  case
    when count(distinct e.department_id) = 1 then max(e.department_id)
    else null
  end as department_id,
  case
    when count(distinct e.department_id) = 1 then max(d.name)
    else null
  end as department_name,
  sum(e.amount) as total_spend,
  count(*) as entry_count
from public.entries e
join public.vendor v on v.id = e.vendor_id
left join public.department d on d.id = e.department_id
where e.is_void = false
  and e.vendor_id is not null
group by e.vendor_id, v.display_name, e.event_id;

-- ----------------------------------------------------------------------------
-- v_vendor_first_bill -- B-05
-- ----------------------------------------------------------------------------
create view public.v_vendor_first_bill with (security_invoker = true) as
with vendor_entries as (
  select
    e.id,
    e.vendor_id,
    e.event_id,
    e.date,
    e.amount
  from public.entries e
  where e.is_void = false
    and e.vendor_id is not null
),
vendor_agg as (
  select
    vendor_id,
    event_id,
    min(date) as first_entry_date,
    max(amount) as max_entry_amount,
    sum(amount) as total_spend,
    count(*) as entry_count
  from vendor_entries
  group by vendor_id, event_id
),
-- The amount on the vendor's actual first entry (by date; ties on the same
-- earliest date broken by lowest entry id, so this is deterministic between
-- refreshes rather than picking whichever row the planner visits first).
first_entry as (
  select distinct on (ve.vendor_id, ve.event_id)
    ve.vendor_id,
    ve.event_id,
    ve.amount as first_entry_amount
  from vendor_entries ve
  order by ve.vendor_id, ve.event_id, ve.date asc nulls last, ve.id asc
),
-- The event's own earliest entry date, from ALL non-void entries (not just
-- vendor_entries' vendor-attributed ones) -- this is "day one of the event"
-- as actually observed in the corpus, independent of any one vendor.
event_dates as (
  select event_id, min(date) as event_first_entry_date
  from public.entries
  where is_void = false
  group by event_id
)
select
  va.vendor_id,
  v.display_name as vendor_display_name,
  va.event_id,
  va.first_entry_date,
  fe.first_entry_amount,
  va.max_entry_amount,
  va.total_spend,
  va.entry_count,
  ed.event_first_entry_date,
  -- Both halves of the blueprint's finding, precomputed so every caller
  -- doesn't redo the comparison: a vendor is genuinely "new mid-event" only
  -- if their first entry date is NOT the event's own earliest observed day
  -- (otherwise they're just the earliest vendor in the corpus, not new).
  (va.first_entry_date is distinct from ed.event_first_entry_date) as is_new_mid_event,
  (fe.first_entry_amount = va.max_entry_amount) as opening_bill_is_largest
from vendor_agg va
join public.vendor v on v.id = va.vendor_id
join first_entry fe
  on fe.vendor_id = va.vendor_id
 and fe.event_id = va.event_id
left join event_dates ed on ed.event_id = va.event_id;

-- DROP VIEW loses grants; these are brand-new objects so a plain grant is
-- all that's needed (no drop-and-recreate here).
grant select on
  public.v_department_vendor_dependency,
  public.v_vendor_exclusivity,
  public.v_vendor_first_bill
to authenticated;
