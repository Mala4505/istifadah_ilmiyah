-- Phase 3 -- analytics engine reporting views. Four views over the compliance/item-catalog
-- schema landed in 20260814000001-3: a reviewer-facing flag triage view, and three views
-- answering the "where is the money going / are we overpaying" questions that
-- rate_reference + item_family/item_catalog exist to support (§3.10, Pillar D).
--
-- security_invoker = true on every view, same reasoning as 20260808000028: a view runs as
-- its creator unless told otherwise, and these must run as the calling user so the
-- underlying table RLS policies apply.
--
-- Department-leak check (done before writing, per the reporting_views precedent of
-- checking as a department-1 reviewer): flags, vendor, rate_reference and item_family are
-- all staff-wide SELECT with no department scoping at all (20260808000026,
-- 20260814000001) -- deliberately so, because compliance triage, vendor identity and rate
-- benchmarking are all explicitly meant to work ACROSS departments. None of the four views
-- below add scoping the base tables don't already have, so none of them narrow OR widen
-- what a department-scoped reviewer already sees through those tables directly. The one
-- place department scoping genuinely applies is v_vendor_concentration's join to entries
-- (entries_select IS scoped by can_see_department): a department-scoped reviewer querying
-- that view sees total_amount and pct_of_total_spend computed only from the entries
-- visible to them, not a true org-wide total -- exactly the same property v_vendor_spend
-- already has today, not a new behaviour introduced here.

-- ----------------------------------------------------------------------------
-- v_compliance_summary -- one row per open flag, joined out to the entry/vendor/
-- department context a reviewer needs to triage without a second query. Ordering
-- copies v_open_issues' severity-then-amount idiom exactly (20260808000028) so the
-- two "what needs attention" views sort the same way.
-- ----------------------------------------------------------------------------
create view public.v_compliance_summary with (security_invoker = true) as
select
  f.id,
  f.flag_type,
  f.severity,
  f.description,
  f.amount_at_risk,
  f.status,
  f.entry_id,
  f.vendor_id,
  v.display_name as vendor_display_name,
  e.department_id,
  d.name as department_name,
  f.created_at,
  f.last_detected_at,
  f.related_entry_ids
from public.flags f
left join public.vendor v on v.id = f.vendor_id
-- entry_id is nullable (vendor_splitting, tds_threshold have no single entry to point
-- at, 20260814000003) -- department_id/department_name are null on those rows, which is
-- correct: a vendor-level flag has no single department to attribute.
left join public.entries e on e.id = f.entry_id
left join public.department d on d.id = e.department_id
where f.status = 'open'
order by
  case f.severity when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end,
  f.amount_at_risk desc nulls last;

-- ----------------------------------------------------------------------------
-- v_vendor_concentration -- per vendor: spend, entry count, open-flag exposure, and
-- spend as a % of total org spend. Deliberately separate from v_vendor_spend
-- (20260811000004) rather than folded into it -- that view is already relied on
-- elsewhere and this adds a flags join plus a window function it has no reason to carry.
-- ----------------------------------------------------------------------------
create view public.v_vendor_concentration with (security_invoker = true) as
with vendor_totals as (
  select
    v.id as vendor_id,
    v.display_name,
    v.normalized_name,
    v.is_confirmed,
    count(e.id) as entry_count,
    sum(e.amount) as total_amount
  from public.vendor v
  left join public.entries e on e.vendor_id = v.id and e.is_void = false
  group by v.id, v.display_name, v.normalized_name, v.is_confirmed
),
vendor_flags as (
  select
    f.vendor_id,
    count(*) as open_flag_count,
    sum(f.amount_at_risk) as open_flag_amount_at_risk
  from public.flags f
  where f.status = 'open' and f.vendor_id is not null
  group by f.vendor_id
)
select
  vt.vendor_id,
  vt.display_name,
  vt.normalized_name,
  vt.is_confirmed,
  vt.entry_count,
  vt.total_amount,
  coalesce(vf.open_flag_count, 0) as open_flag_count,
  vf.open_flag_amount_at_risk,
  -- sum(...) over () is the org-wide (or, under RLS, "everything this caller can see")
  -- denominator -- nullif guards a would-be division by zero into a clean null rather
  -- than an error when nothing is visible at all (e.g. a brand new department with no
  -- entries yet).
  round(
    coalesce(vt.total_amount, 0)
    / nullif(sum(coalesce(vt.total_amount, 0)) over (), 0) * 100,
    2
  ) as pct_of_total_spend
from vendor_totals vt
left join vendor_flags vf on vf.vendor_id = vt.vendor_id;

-- ----------------------------------------------------------------------------
-- v_spend_by_family -- per item_family: total spend, observation count, distinct
-- vendor count. LEFT JOIN from item_family (not rate_reference) so a family with zero
-- comparable observations yet still appears with zeroed-out figures -- is_confirmed is
-- carried specifically so the UI can list proposed families alongside spend-backed ones,
-- which only works if families with no spend history aren't simply absent from the view.
-- is_comparable filter lives in the join's ON clause, not a WHERE, so it narrows which
-- rate_reference rows count without turning the LEFT JOIN back into an INNER JOIN for
-- families that have no comparable rows at all.
-- ----------------------------------------------------------------------------
create view public.v_spend_by_family with (security_invoker = true) as
select
  fam.id as item_family_id,
  fam.family_key,
  fam.label,
  fam.default_unit,
  fam.is_confirmed,
  coalesce(sum(rr.net_rate * coalesce(rr.quantity, 1)), 0) as total_spend,
  count(rr.id) as observation_count,
  count(distinct rr.vendor_id) as vendor_count
from public.item_family fam
left join public.rate_reference rr
  on rr.item_family_id = fam.id and rr.is_comparable = true
group by fam.id, fam.family_key, fam.label, fam.default_unit, fam.is_confirmed;

-- ----------------------------------------------------------------------------
-- v_rate_benchmark -- per item_family_id + unit_normalized: median/min/max net_rate,
-- observation count, distinct vendor count. The Pillar D "are we overpaying" source.
-- INNER JOIN to item_family here (unlike v_spend_by_family): a benchmark grouped only by
-- a bare item_family_id is unusable in a UI without the family's name, and unlike spend
-- (a catalog-browsing view where an empty family is still worth listing), a benchmark
-- with zero observations has nothing to show -- there's no reason to manufacture an
-- all-null row for it. Expect this to return few/sparse rows against the real corpus:
-- ~21 documents with almost no cross-vendor item overlap on the same family+unit pair
-- (20260814000001's header) -- that's the expected state, not a bug to work around.
-- ----------------------------------------------------------------------------
create view public.v_rate_benchmark with (security_invoker = true) as
select
  rr.item_family_id,
  fam.family_key,
  fam.label as family_label,
  rr.unit_normalized,
  percentile_cont(0.5) within group (order by rr.net_rate) as median_rate,
  count(*) as observation_count,
  count(distinct rr.vendor_id) as vendor_count,
  min(rr.net_rate) as min_rate,
  max(rr.net_rate) as max_rate
from public.rate_reference rr
join public.item_family fam on fam.id = rr.item_family_id
where rr.is_comparable = true
group by rr.item_family_id, fam.family_key, fam.label, rr.unit_normalized;

-- A view is its own object, distinct from its base tables -- the broad
-- `grant select ... on all tables in schema public` in 20260808000026_rls_policies.sql
-- ran *before* any of these views existed, so it does not cover them. Without an
-- explicit grant here, PostgREST would return "permission denied" for every one of
-- these views even though security_invoker RLS would otherwise allow the row.
grant select on
  public.v_compliance_summary,
  public.v_vendor_concentration,
  public.v_spend_by_family,
  public.v_rate_benchmark
to authenticated;
