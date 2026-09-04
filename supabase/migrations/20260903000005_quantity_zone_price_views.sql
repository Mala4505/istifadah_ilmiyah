-- reporting-blueprint.md §8 Phase Five, Family C / B: "The rest of the line-item
-- family (C-02, C-05 … C-08) and the vendor family (B-02 … B-09)." Three views
-- for C-07, C-08 and B-06 -- all three read the same comparable-rate population
-- rate_reference already established (is_comparable = true, item_family_id not
-- null via the inner join to item_family), and all three are grouped-by
-- (aggregate) views, so per the event-scoping lesson already learned on
-- v_rate_benchmark / v_spend_by_family (20260822000011): event_id goes in the
-- GROUP BY, not just the SELECT list, or it decorates rather than scopes.
--
--   v_quantity_by_unit -- C-07 "Not rupees — sqft, nos, days. Consumption in
--     physical terms." Per (item_family, unit_normalized, event): summed
--     quantity, observation/vendor/entry counts. Units are NOT comparable
--     across each other (a sqft total and a nos total can't share an axis), so
--     this view deliberately keeps unit_normalized as a group key rather than
--     summing quantity across units -- the app-side small-multiples chart reads
--     one mini-chart per unit straight off that grain. Rows need a real
--     quantity to mean anything, so `rr.quantity is not null` is a WHERE here,
--     the same way is_comparable already is -- a row with no quantity
--     contributes nothing to "how much did we buy" and manufacturing a
--     zero-quantity row would understate nothing while still cluttering the
--     unit breakdown.
--
--   v_zone_unit_economics -- C-08 "Rate paid for the same item at different
--     sites." Per (item_family, unit_normalized, zone, event): median/avg
--     net_rate + observation count, plus the (item_family, unit, event) median
--     across every zone (family_median_rate) so the app can shade each cell by
--     cell-rate ÷ family-median-rate without a second query. "Only families
--     billed in ≥2 zones" (blueprint's own words for this report) is baked into
--     the view as `where zone_count >= 2`, not left to the query site: unlike
--     the rate-benchmark reliability threshold (RATE_BENCHMARK_MIN_VENDORS,
--     applied in TS so a thin single-vendor row still shows greyed-out), a
--     family billed in exactly one zone cannot produce this report's finding at
--     all -- there is no second zone to compare against -- so it is excluded at
--     the source rather than rendered as an empty comparison.
--
--   v_vendor_price_by_family -- B-06 "For each item we buy repeatedly: who
--     charges what, ranked." Exactly v_rate_benchmark's grain
--     (item_family, unit_normalized, event) broken out one level further to
--     (item_family, unit_normalized, vendor, event): median/min/max net_rate
--     per vendor, plus the same family_median_rate + family-level vendor_count
--     columns so the ranked dot plot can draw its median rule and the section
--     can report "N families with ≥2 vendors priced" without a second query.
--     Deliberately NOT filtered to vendor_count >= 2 in the view -- mirrors
--     v_rate_benchmark's own precedent of returning every row (including
--     single-vendor families) and letting the query site decide what counts as
--     "reliably ranked" via the existing RATE_BENCHMARK_MIN_VENDORS threshold
--     (lib/analytics/thresholds.ts), so a single-vendor family still lists in
--     the table rather than silently vanishing.
--
-- Department-leak check (reporting-blueprint.md §2, same property v_vendor_spend
-- and v_rate_benchmark already document): rate_reference, item_family and
-- vendor are staff-wide SELECT with no department scoping (deliberate --
-- cross-department/cross-vendor comparison is the whole point of this family of
-- reports). entries IS department-scoped by RLS (can_see_department), and
-- so -- unlike vendor/item_family -- is zone (zone_select requires
-- can_see_department(zone.department_id), 20260808000026:119-124; not
-- staff-wide like vendor_select). v_quantity_by_unit only reaches entries via a
-- LEFT JOIN for event_id, so a department-scoped reviewer sees every
-- comparable observation's quantity regardless of department, just with
-- event_id nulled out for entries outside their department (same
-- best-effort-resolution-or-null property v_rate_benchmark already has).
-- v_zone_unit_economics and v_vendor_price_by_family both filter on data that
-- only exists once entries/zone are joined (zone_id is not null / event_id),
-- so a department-scoped reviewer sees zone economics only for zones and
-- entries in a department they can see -- narrower than the staff-wide
-- family_median_rate/vendor_count columns computed alongside them, which stay
-- computed from the same department-visible slice, not the full corpus. In
-- this codebase every zone currently sits under department_id = 1 (zone.sql's
-- seed note), so the distinction is latent rather than observed today.
--
-- percentile_cont(...) returns double precision; round(double, int) does not
-- exist in Postgres (only round(numeric, int)). None of these three views call
-- round() on a percentile_cont result -- like v_rate_benchmark before them,
-- they return the raw double and let the app's formatINR/formatNumber round
-- for display -- so the double-vs-numeric cast trap does not apply here, but
-- is worth restating for whoever adds an arithmetic column later (e.g. a
-- ratio) and reaches for round() directly on a percentile_cont output.
--
-- security_invoker = true on all three (every view in this codebase runs as
-- the calling user so base-table RLS applies). Each is a new object the broad
-- `grant select on all tables in schema public` (20260808000026) predates, so
-- each needs its own explicit grant, same as every other view added since.

-- ----------------------------------------------------------------------------
-- v_quantity_by_unit -- C-07
-- ----------------------------------------------------------------------------
create view public.v_quantity_by_unit with (security_invoker = true) as
select
  rr.item_family_id,
  fam.family_key,
  fam.label as family_label,
  rr.unit_normalized,
  e.event_id,
  sum(rr.quantity) as total_quantity,
  count(*) as observation_count,
  count(distinct rr.vendor_id) as vendor_count,
  count(distinct rr.entry_id) as entry_count
from public.rate_reference rr
join public.item_family fam on fam.id = rr.item_family_id
left join public.entries e on e.id = rr.entry_id
where rr.is_comparable = true
  and rr.quantity is not null
group by rr.item_family_id, fam.family_key, fam.label, rr.unit_normalized, e.event_id;

-- ----------------------------------------------------------------------------
-- v_zone_unit_economics -- C-08
-- ----------------------------------------------------------------------------
create view public.v_zone_unit_economics with (security_invoker = true) as
with obs as (
  select
    rr.item_family_id,
    fam.family_key,
    fam.label as family_label,
    rr.unit_normalized,
    rr.net_rate,
    e.event_id,
    e.zone_id,
    z.name as zone_name,
    z.zone_number
  from public.rate_reference rr
  join public.item_family fam on fam.id = rr.item_family_id
  left join public.entries e on e.id = rr.entry_id
  left join public.zone z on z.id = e.zone_id
  where rr.is_comparable = true
    and e.zone_id is not null
),
zone_level as (
  select
    item_family_id,
    family_key,
    family_label,
    unit_normalized,
    event_id,
    zone_id,
    zone_name,
    zone_number,
    percentile_cont(0.5) within group (order by net_rate) as median_rate,
    avg(net_rate) as avg_rate,
    count(*) as observation_count
  from obs
  group by item_family_id, family_key, family_label, unit_normalized, event_id, zone_id, zone_name, zone_number
),
family_level as (
  select
    item_family_id,
    unit_normalized,
    event_id,
    percentile_cont(0.5) within group (order by net_rate) as family_median_rate,
    count(distinct zone_id) as zone_count
  from obs
  group by item_family_id, unit_normalized, event_id
)
select
  zl.item_family_id,
  zl.family_key,
  zl.family_label,
  zl.unit_normalized,
  zl.event_id,
  zl.zone_id,
  zl.zone_name,
  zl.zone_number,
  zl.median_rate,
  zl.avg_rate,
  zl.observation_count,
  fl.family_median_rate,
  fl.zone_count
from zone_level zl
join family_level fl
  on fl.item_family_id = zl.item_family_id
 and fl.unit_normalized is not distinct from zl.unit_normalized
 and fl.event_id is not distinct from zl.event_id
where fl.zone_count >= 2;

-- ----------------------------------------------------------------------------
-- v_vendor_price_by_family -- B-06
-- ----------------------------------------------------------------------------
create view public.v_vendor_price_by_family with (security_invoker = true) as
with obs as (
  select
    rr.item_family_id,
    fam.family_key,
    fam.label as family_label,
    rr.unit_normalized,
    rr.vendor_id,
    v.display_name as vendor_display_name,
    rr.net_rate,
    e.event_id
  from public.rate_reference rr
  join public.item_family fam on fam.id = rr.item_family_id
  left join public.vendor v on v.id = rr.vendor_id
  left join public.entries e on e.id = rr.entry_id
  where rr.is_comparable = true
),
vendor_level as (
  select
    item_family_id,
    family_key,
    family_label,
    unit_normalized,
    vendor_id,
    vendor_display_name,
    event_id,
    percentile_cont(0.5) within group (order by net_rate) as median_rate,
    count(*) as observation_count,
    min(net_rate) as min_rate,
    max(net_rate) as max_rate
  from obs
  group by item_family_id, family_key, family_label, unit_normalized, vendor_id, vendor_display_name, event_id
),
family_level as (
  select
    item_family_id,
    unit_normalized,
    event_id,
    percentile_cont(0.5) within group (order by net_rate) as family_median_rate,
    count(distinct vendor_id) as vendor_count
  from obs
  group by item_family_id, unit_normalized, event_id
)
select
  vl.item_family_id,
  vl.family_key,
  vl.family_label,
  vl.unit_normalized,
  vl.vendor_id,
  vl.vendor_display_name,
  vl.event_id,
  vl.median_rate,
  vl.observation_count,
  vl.min_rate,
  vl.max_rate,
  fl.family_median_rate,
  fl.vendor_count
from vendor_level vl
join family_level fl
  on fl.item_family_id = vl.item_family_id
 and fl.unit_normalized is not distinct from vl.unit_normalized
 and fl.event_id is not distinct from vl.event_id;

-- DROP VIEW loses grants; these are brand-new objects so a plain grant is all
-- that's needed (no drop-and-recreate here).
grant select on
  public.v_quantity_by_unit,
  public.v_zone_unit_economics,
  public.v_vendor_price_by_family
to authenticated;
