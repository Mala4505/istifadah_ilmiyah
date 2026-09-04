-- reporting-blueprint.md §8 Phase Six, Family A ("Budget & Spend — where the
-- money went, and where it is heading"). Three views for the "structure of the
-- budget" cluster:
--
--   v_budget_revision_history -- A-02 "Allocations are dated: original ask ->
--     approved -> each revision -> today, as a waterfall. Shows who kept coming
--     back for more." One row per budget_allocation snapshot, i.e. per
--     (budget_head, import_batch) pair (that is budget_allocation's own unique
--     key), carrying the running revision sequence, the change in approved and
--     in "effective" amount since the previous snapshot, and first/last flags.
--     GRAIN: one row per snapshot. A head allocated once has exactly one row
--     (revision_seq = 1, is_first = is_latest = true, both deltas null). The
--     revision TRAIL is the set of rows for a head ordered by revision_seq;
--     "revised upward" = any row after the first whose effective_delta > 0.
--
--     event_id: budget_allocation carries its own not-null event_id column
--     (added by 20260822000005_event_scoping.sql -- it is NOT resolved through
--     import_batch; the brief that scoped this work predated that migration).
--     So the window is partitioned by (budget_head_id, event_id): a head that
--     somehow has allocations in two events gets an independent revision run
--     per event, matching how v_budget_vs_actual already does
--     `distinct on (budget_head_id, event_id)` off this same table.
--
--     effective_amount = coalesce(nullif(approved_amount, 0), request_amount, 0).
--     RATIONALE: 20260808000016_budget_allocation.sql's own header flags that in
--     the sample data approved_amount = 0 on every head while request/utilised
--     are populated. A revision report keyed only on approved_amount would show
--     a flat zero line for that data shape. effective_amount is "the figure
--     currently under revision" -- the approved number once it is real, the
--     requested number until then -- so the waterfall and the "₹X added since
--     first ask" KPI stay meaningful either way. approved_delta is kept
--     alongside (raw approved_amount minus its own lag) for callers that want
--     the strict approved-only movement.
--
--   v_zone_category_matrix -- A-06 "What each site spends on. Reveals sites
--     whose mix is unlike every comparable site." One row per
--     (zone, cost_center, event). "Budget category" in the blueprint == the
--     cost_center table (renamed from budget_category, 20260813000004); the
--     enriched-entry column names are cost_center_id / cost_center_name (see
--     v_entry_enriched, 20260828000001). Nulls are kept, not dropped: a null
--     zone becomes 'Unassigned zone', a null cost_center becomes
--     'Uncategorised', so the matrix shows enrichment gaps rather than hiding
--     spend. total_amount is coalesce(sum(amount), 0); entries.amount is
--     nullable so a group of all-null amounts reports 0, not null.
--
--   v_budget_category_mix -- A-07 "Where money goes structurally, expressed as
--     SHARE rather than total." One row per (cost_center, event): entry_count +
--     total_amount, plus cost_center_is_confirmed so the app can mark
--     unconfirmed categories. This is v_zone_category_matrix summed over zones,
--     kept as its own view so the A-07 section issues one flat query instead of
--     re-aggregating the matrix client-side. Same null-cost_center ->
--     'Uncategorised' treatment.
--
-- Aggregate-view event-scoping (same lesson as 20260822000007 /
-- 20260903000005): event_id is a GROUP BY key, not just a SELECT-list
-- decoration, so a zone/category/head active in two events yields two rows.
-- Filtering to one event happens at the query site, never in the view.
--
-- round()/double-precision trap (20260903000005 header, Obs 54/57): none of
-- these views round(). Every numeric output is sum(numeric_col), a count, a
-- row_number, or numeric - numeric -- all of which stay numeric/bigint. There
-- is no avg / percentile_cont / division / sqrt / power anywhere here, so no
-- ::numeric cast is needed. A caller adding a ratio column later must cast
-- before round().
--
-- RLS (security_invoker = true on all three, like every view in this repo):
-- base-table policies apply to the calling user.
--   * budget_head is department-scoped (20260808000026: department_id is null
--     OR can_see_department(department_id)); budget_allocation is visible only
--     through a visible budget_head. So a department-scoped reviewer sees
--     v_budget_revision_history rows only for heads in their department(s) plus
--     department-less heads -- narrower than a full-access reviewer, not an
--     error.
--   * entries is department-scoped (can_see_department) and zone is
--     department-scoped (20260808000026:123-124). cost_center is staff-wide
--     read. So v_zone_category_matrix / v_budget_category_mix show a
--     department-scoped reviewer only their own departments' entries (and
--     therefore only zones/categories those entries touch); the category list
--     itself is not the leak surface, the entries behind each cell are.
--   * In the current seed every zone sits under department_id = 1 (zone.sql
--     seed note), so this scoping is latent rather than observed today.
--
-- Grants: each view is a new object the blanket
-- `grant select on all tables in schema public` (20260808000026) predates, so
-- each needs its own explicit grant. No DROP here (brand-new objects), so a
-- plain grant is all that is required.

-- ----------------------------------------------------------------------------
-- v_budget_revision_history -- A-02
-- ----------------------------------------------------------------------------
create view public.v_budget_revision_history with (security_invoker = true) as
with snapshots as (
  select
    ba.id                                          as allocation_id,
    ba.budget_head_id,
    coalesce(bh.short_label, bh.raw_label)         as budget_head_label,
    bh.department_id,
    d.name                                         as department_name,
    ba.event_id,
    ba.import_batch_id,
    ba.as_of,
    ba.request_amount,
    ba.approved_amount,
    ba.utilised_amount,
    ba.balance_amount,
    coalesce(nullif(ba.approved_amount, 0), ba.request_amount, 0) as effective_amount
  from public.budget_allocation ba
  join public.budget_head bh on bh.id = ba.budget_head_id
  left join public.department d on d.id = bh.department_id
)
select
  s.allocation_id,
  s.budget_head_id,
  s.budget_head_label,
  s.department_id,
  s.department_name,
  s.event_id,
  s.import_batch_id,
  s.as_of,
  s.request_amount,
  s.approved_amount,
  s.utilised_amount,
  s.balance_amount,
  s.effective_amount,
  row_number() over w                               as revision_seq,
  s.approved_amount  - lag(s.approved_amount)  over w as approved_delta,
  s.effective_amount - lag(s.effective_amount) over w as effective_delta,
  (row_number() over w = 1)                         as is_first,
  (row_number() over w
     = count(*) over (partition by s.budget_head_id, s.event_id)) as is_latest
from snapshots s
window w as (
  partition by s.budget_head_id, s.event_id
  order by s.as_of, s.allocation_id
)
order by s.budget_head_id, revision_seq;

-- ----------------------------------------------------------------------------
-- v_zone_category_matrix -- A-06
-- ----------------------------------------------------------------------------
create view public.v_zone_category_matrix with (security_invoker = true) as
select
  e.zone_id,
  coalesce(z.name, 'Unassigned zone')  as zone_name,
  z.zone_number,
  e.cost_center_id,
  coalesce(cc.name, 'Uncategorised')    as cost_center_name,
  e.event_id,
  count(*)                              as entry_count,
  coalesce(sum(e.amount), 0)            as total_amount
from public.entries e
left join public.zone z         on z.id  = e.zone_id
left join public.cost_center cc  on cc.id = e.cost_center_id
where e.is_void = false
group by e.zone_id, z.name, z.zone_number, e.cost_center_id, cc.name, e.event_id;

-- ----------------------------------------------------------------------------
-- v_budget_category_mix -- A-07
-- ----------------------------------------------------------------------------
create view public.v_budget_category_mix with (security_invoker = true) as
select
  e.cost_center_id,
  coalesce(cc.name, 'Uncategorised')  as cost_center_name,
  cc.is_confirmed                     as cost_center_is_confirmed,
  e.event_id,
  count(*)                            as entry_count,
  coalesce(sum(e.amount), 0)          as total_amount
from public.entries e
left join public.cost_center cc on cc.id = e.cost_center_id
where e.is_void = false
group by e.cost_center_id, cc.name, cc.is_confirmed, e.event_id;

grant select on
  public.v_budget_revision_history,
  public.v_zone_category_matrix,
  public.v_budget_category_mix
to authenticated;
