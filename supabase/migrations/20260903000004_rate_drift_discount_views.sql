-- reporting-blueprint.md §8 Phase Five, Family C: "C-05 Rate drift across the
-- event" and "C-06 Discount consistency".
--
--   v_rate_drift -- C-05. "Same vendor, same item, price movement week by
--     week. Detects mid-event escalation while there is still time to act."
--     Grain: one row per (vendor_id, item_family_id, event_id, week_start) --
--     week_start is the ISO week (Postgres's date_trunc('week', ...) already
--     uses the ISO-8601 Monday-start definition, so no separate isoyear/
--     isoweek extraction is needed). Per week: observation count and the
--     min/median/max net_rate observed that week. Two window columns carry
--     the whole series' first and last week's median so the query site can
--     compute a drift % without a second round trip; `drift_pct` is included
--     directly too since it is a pure function of those two numbers, and
--     `series_week_count` / `series_observation_count` are the gate the
--     query site applies for "only vendor×item pairs with >= 2 observations
--     in >= 2 distinct weeks" (a series with >= 2 distinct weeks already has
--     >= 2 observations, one per week at minimum, so series_week_count >= 2
--     is the binding condition; series_observation_count is exposed too so
--     the query site never has to re-derive it from the per-week rows).
--     item_catalog_id is deliberately NOT part of the grain here (unlike
--     item_family_id) -- the blueprint's C-05 wording offers item_family_id
--     "or item_catalog_id"; item_family is the level most purchases actually
--     repeat at across a whole event (item_catalog's exact-spec match is
--     often one-off per invoice), so family is the grain that gives a series
--     with more than one data point to plot.
--
--   v_discount_consistency -- C-06. "The same vendor giving different
--     discounts to different departments on the same item family." Grain:
--     one row per (vendor_id, department_id, item_family_id, event_id),
--     aggregating rate_reference.discount_pct (numeric(6,3)) -- NOT
--     document_extraction_line_item.discount_ocr/_verified, which is free
--     text like "10%+5%" and cannot be aggregated. discount_pct is populated
--     only by the OLDER verify_document_extraction bodies
--     (20260813000002/20260814000011/20260817000003); the CURRENT one
--     (20260820000003) inserts rate_reference rows without it at all, so
--     against the present corpus this view returns few or zero rows -- by
--     design, not a bug, and the query site surfaces the coverage columns
--     below prominently rather than pretending the comparison is complete.
--     Two coverage columns travel on every row, constant per (item_family_id,
--     event_id): family_observation_count (every comparable rate_reference
--     row in that family/event, whether or not it carries a discount) and
--     family_discount_count (how many of those carry a numeric discount) --
--     "N of M comparable purchases in this family have a captured discount".
--     The cross-department SPREAD itself (max discount − min discount across
--     a vendor+family's departments) is deliberately left to the query site:
--     it is a max()-min() over the rows this view already returns grouped by
--     (vendor_id, item_family_id, event_id), not a further SQL aggregation,
--     and the blueprint says as much ("plus the family-level spread the app
--     can also compute").
--
-- security_invoker = true on both (every view in this codebase runs as the
-- calling user so base-table RLS applies). Both are new objects the broad
-- `grant select on all tables in schema public` (20260808000026) predates,
-- so both need their own explicit grant. event_id is a plain output column
-- on both -- filtering happens at the query site, matching 20260822000011.
--
-- Department-leak note (both views): vendor, rate_reference and item_family
-- carry no department_id and are staff-wide SELECT (deliberate -- see
-- 20260814000001's item_family_select / item_catalog_select policies and
-- 20260903000002's header on v_rate_observation, which resolves department
-- the same way). entries IS department-scoped by RLS
-- (private.can_see_department, 20260808000026). Both views resolve
-- department_id/event_id via `left join public.entries e on e.id =
-- rr.entry_id`: for a department-scoped reviewer, a rate_reference row whose
-- linked entry sits in a department they cannot see does NOT disappear --
-- the LEFT JOIN just resolves department_id/event_id (and, transitively,
-- department_name) to null for that row, because RLS makes the joined
-- `entries` row invisible to them, not because the observation lacks one.
-- The rate/discount figures and the vendor/item-family identity stay visible
-- regardless -- exactly the same leak-by-design property v_rate_observation
-- already documents, and for the same reason: cross-department rate/discount
-- comparison is the entire point of both reports. An entry-less observation
-- (no entry_id at all) reads identically -- null department_id/event_id,
-- row kept -- so the query site must use `.or('event_id.eq.<id>,event_id.is.null')`
-- rather than a plain `.eq('event_id', ...)`, same as v_open_issues /
-- v_compliance_summary.
--
-- percentile_cont(...) returns double precision; round(double precision, int)
-- does not exist in Postgres (only round(numeric, int)) -- every percentile
-- is cast to ::numeric before rounding, same fix as 20260903000002.

-- ----------------------------------------------------------------------------
-- v_rate_drift -- C-05
-- ----------------------------------------------------------------------------
create view public.v_rate_drift with (security_invoker = true) as
with obs as (
  select
    rr.vendor_id,
    v.display_name as vendor_display_name,
    rr.item_family_id,
    fam.family_key,
    fam.label as family_label,
    e.event_id,
    date_trunc('week', rr.observed_date::timestamp)::date as week_start,
    rr.net_rate
  from public.rate_reference rr
  join public.item_family fam on fam.id = rr.item_family_id
  left join public.vendor v on v.id = rr.vendor_id
  left join public.entries e on e.id = rr.entry_id
  where rr.is_comparable = true
    and rr.item_family_id is not null
    and rr.net_rate is not null
    and rr.observed_date is not null
),
weekly as (
  select
    vendor_id,
    vendor_display_name,
    item_family_id,
    family_key,
    family_label,
    event_id,
    week_start,
    count(*) as observation_count,
    min(net_rate) as min_rate,
    round(percentile_cont(0.5) within group (order by net_rate)::numeric, 2) as median_rate,
    max(net_rate) as max_rate
  from obs
  group by vendor_id, vendor_display_name, item_family_id, family_key, family_label, event_id, week_start
),
-- One row per (vendor, item_family, event) series: the week count/observation
-- total the query site gates on, plus the first and last week's median in
-- that series. `array_agg(... order by week_start)` picks off index 1 for
-- "first" and "last" (via a descending-ordered second agg) rather than
-- first_value()/last_value() window functions repeated per output column --
-- same numbers, computed once per series instead of once per output column.
series_bounds as (
  select
    vendor_id,
    item_family_id,
    event_id,
    count(*) as series_week_count,
    sum(observation_count) as series_observation_count,
    (array_agg(week_start order by week_start asc))[1] as first_week_start,
    (array_agg(median_rate order by week_start asc))[1] as first_week_median,
    (array_agg(week_start order by week_start desc))[1] as last_week_start,
    (array_agg(median_rate order by week_start desc))[1] as last_week_median
  from weekly
  group by vendor_id, item_family_id, event_id
)
select
  w.vendor_id,
  w.vendor_display_name,
  w.item_family_id,
  w.family_key,
  w.family_label,
  w.event_id,
  w.week_start,
  w.observation_count,
  w.min_rate,
  w.median_rate,
  w.max_rate,
  sb.series_week_count,
  sb.series_observation_count,
  sb.first_week_start,
  sb.first_week_median,
  sb.last_week_start,
  sb.last_week_median,
  case
    when sb.first_week_median is null or sb.first_week_median = 0 then null
    else round(((sb.last_week_median - sb.first_week_median) / sb.first_week_median) * 100, 2)
  end as drift_pct
from weekly w
join series_bounds sb
  on sb.vendor_id = w.vendor_id
 and sb.item_family_id = w.item_family_id
 and sb.event_id is not distinct from w.event_id;

-- ----------------------------------------------------------------------------
-- v_discount_consistency -- C-06
-- ----------------------------------------------------------------------------
create view public.v_discount_consistency with (security_invoker = true) as
with comparable as (
  select
    rr.id,
    rr.vendor_id,
    rr.item_family_id,
    fam.family_key,
    fam.label as family_label,
    rr.discount_pct,
    e.department_id,
    e.event_id
  from public.rate_reference rr
  join public.item_family fam on fam.id = rr.item_family_id
  left join public.entries e on e.id = rr.entry_id
  where rr.is_comparable = true
    and rr.item_family_id is not null
),
family_coverage as (
  select
    item_family_id,
    event_id,
    count(*) as family_observation_count,
    count(discount_pct) as family_discount_count
  from comparable
  group by item_family_id, event_id
)
select
  c.vendor_id,
  v.display_name as vendor_display_name,
  c.item_family_id,
  c.family_key,
  c.family_label,
  c.department_id,
  d.name as department_name,
  c.event_id,
  count(*) as observation_count,
  round(avg(c.discount_pct), 2) as avg_discount_pct,
  min(c.discount_pct) as min_discount_pct,
  max(c.discount_pct) as max_discount_pct,
  fc.family_observation_count,
  fc.family_discount_count
from comparable c
left join public.vendor v on v.id = c.vendor_id
left join public.department d on d.id = c.department_id
join family_coverage fc on fc.item_family_id = c.item_family_id and fc.event_id is not distinct from c.event_id
where c.discount_pct is not null
group by
  c.vendor_id, v.display_name, c.item_family_id, c.family_key, c.family_label,
  c.department_id, d.name, c.event_id, fc.family_observation_count, fc.family_discount_count;

-- DROP VIEW loses grants; these are brand-new objects so a plain grant is all
-- that's needed (no drop-and-recreate here).
grant select on
  public.v_rate_drift,
  public.v_discount_consistency
to authenticated;
