-- reporting-blueprint.md §8 Phase Five, Family B: B-02 vendor scorecard and
-- B-09 activity span & dormancy.
--
--   v_vendor_scorecard -- B-02. "One card per vendor: spend, share, price
--     against our benchmark, discount given, document quality, GSTIN
--     validity, flag history." One row per (vendor, event), built on top of
--     the existing v_vendor_spend (spend, first/last date, document
--     coverage) and v_vendor_concentration (share of spend), joined with
--     three new measures this scorecard needs and neither existing view
--     carries:
--       - avg_price_ratio / priced_observation_count -- this vendor's own
--         comparable rate_reference observations, each expressed as
--         net_rate / the (item_family, unit, event) median (the same median
--         v_rate_observation and v_rate_benchmark compute), then averaged.
--         Recomputed here rather than reused from v_rate_observation because
--         that view has no per-vendor rollup and exposes the per-observation
--         grain this scorecard needs to average away.
--       - avg_discount_pct / discount_observation_count -- straight average
--         of rate_reference.discount_pct where it is populated. Per
--         docs/reporting-blueprint.md's schema notes, the verify RPC usually
--         leaves discount_pct null against the current corpus, so these two
--         columns read null / 0 for most vendors today -- that is the
--         expected state, not a bug, and the app must show the observation
--         count on the face of it rather than imply "this vendor gives no
--         discount."
--       - gstin / gstin_status -- GSTIN validity is DELIBERATELY NOT a
--         checksum reimplementation. The checksum already lives in
--         lib/analytics/gstin.ts (unit-tested) and is already enforced by
--         lib/jobs/handlers/extract.ts, which raises a
--         reconciliation_exception of type 'vendor_gstin_invalid_checksum'
--         (a misread/miskeyed GSTIN, checksum-provably wrong) or
--         'vendor_gstin_is_own_org' (the bill carries our own GSTIN as the
--         vendor's -- a self-billing mixup) -- see
--         20260820000002_gstin_checksum_and_page_failure_exceptions.sql and
--         20260814000010_document_extraction_vendor_email.sql. This view
--         reads that verdict rather than re-deriving it:
--           'missing' -- vendor.gstin is null.
--           'flagged' -- vendor.gstin is set AND at least one of this
--             vendor's entries (in this event) carries an OPEN exception of
--             either type above.
--           'valid'   -- vendor.gstin is set and no such open exception
--             exists. This does NOT mean GSTN has confirmed the number is
--             live/registered -- only that nothing in this corpus has
--             disproved it. State this on the card, not just in code.
--       - flag_history_count / open_flag_count / open_flag_amount_at_risk --
--         "flag history" is deliberately ALL-status (open + confirmed +
--         dismissed), because a scorecard for a supplier relationship should
--         show the full record, not just what is outstanding today.
--         Resolved via flags.vendor_id directly (the vendor-level detectors:
--         vendor_cluster, vendor_splitting, gstin_invalid, gstin_missing,
--         tds_threshold -- see 20260814000003_flags_extend.sql) -- the SAME
--         vendor-attribution rule v_vendor_concentration's vendor_flags CTE
--         already uses for open_flag_count/open_flag_amount_at_risk, just
--         without the status filter. This carries forward the same known
--         gap v_vendor_concentration documents: an entry-level flag
--         (duplicate_payment, rate_drift, discount_inconsistency,
--         missing_documentation) that was never given a vendor_id is not
--         counted here either. Not fixed in this migration -- flagged in
--         this file's own INTEGRATION NOTES for the parent to weigh, since
--         changing that resolution rule changes v_vendor_concentration's
--         published open_flag_count too and is out of this migration's
--         assigned scope.
--
--   v_vendor_activity_span -- B-09. "First and last invoice per vendor, and
--     the gaps. Surfaces vendors that appear once for a large amount and are
--     never seen again." One row per (vendor, event), computed directly from
--     entries (not from v_vendor_spend, which only carries first/last date
--     and not the gap structure between them):
--       - active_span_days = last_entry_date - first_entry_date.
--       - distinct_active_days = count of distinct calendar dates this
--         vendor billed on, in this event.
--       - max_gap_days = the largest gap, in days, between two
--         CONSECUTIVE distinct active dates (not consecutive entries --
--         several entries on the same day are one "visit", not several
--         gap-free hops). Computed via lag() over the distinct-date list, so
--         a vendor active on only one date gets a null gap (coalesced to 0
--         in the final select -- there is no second date to gap from).
--       - active_dates -- every distinct date this vendor billed on, in
--         this event, ascending. This is the one array-typed column in this
--         migration: the grain stays one row per (vendor, event); this is an
--         aggregate array on that row, the same shape Postgres already uses
--         for entries.related_entry_ids etc. It exists so the activity
--         timeline chart can plot a dot per active day without a second,
--         entry-grain query -- the view's own grain is unchanged.
--       - single_appearance = (entry_count = 1). The materiality threshold
--         ("large amount") that turns this into a finding is applied at the
--         query site (lib/reports/surfaces/vendor-scorecard.ts), not here --
--         this view exposes the raw facts a threshold gets applied to,
--         consistent with the read-only-facts-in-the-view style every other
--         Phase Four/Five view in this codebase follows.
--
-- security_invoker = true on both (every view in this codebase runs as the
-- calling user so base-table RLS applies). Both are brand-new objects, so
-- each needs its own explicit grant -- neither is covered by the historical
-- blanket grant (20260808000026) or by any later one.
--
-- event_id is a plain output column on both, never filtered in the view
-- itself -- filtering happens at the query site (lib/reports/surfaces/
-- vendor-scorecard.ts), matching 20260822000011's pattern. Every aggregate
-- below groups by event_id (not just vendor_id), so a vendor active across
-- two events gets two independent rows rather than one silently-summed row.
--
-- Department-leak analysis (state what a department-scoped reviewer sees,
-- same property v_vendor_spend already documents): vendor, rate_reference,
-- item_family and flags/reconciliation_exception are staff-wide with no
-- department scoping -- a department-scoped reviewer sees the SAME
-- avg_price_ratio, avg_discount_pct, gstin_status and flag_history_count for
-- a shared vendor as every other department (deliberate -- cross-department
-- vendor comparison is the point of Family B). entry_count, total_amount,
-- entries_with_documents, document_coverage_pct, and every column on
-- v_vendor_activity_span ARE department-scoped, because they are summed
-- from `entries`, which RLS restricts to `can_see_department`; a
-- department-scoped reviewer's activity span for a shared vendor reflects
-- only the entries their own department filed against that vendor.

-- ----------------------------------------------------------------------------
-- v_vendor_scorecard -- B-02
-- ----------------------------------------------------------------------------
create view public.v_vendor_scorecard with (security_invoker = true) as
with base as (
  select
    vs.vendor_id,
    vs.display_name,
    vs.normalized_name,
    vs.is_confirmed,
    vs.event_id,
    vs.entry_count,
    vs.total_amount,
    vs.first_entry_date,
    vs.last_entry_date,
    vs.entries_with_documents,
    vs.document_coverage_pct
  from public.v_vendor_spend vs
  where vs.entry_count > 0
),
comparable_obs as (
  select
    rr.item_family_id,
    rr.unit_normalized,
    e.event_id,
    rr.vendor_id,
    rr.net_rate
  from public.rate_reference rr
  left join public.entries e on e.id = rr.entry_id
  where rr.is_comparable = true
    and rr.item_family_id is not null
    and rr.net_rate is not null
),
price_medians as (
  -- Same (item_family, unit, event) median v_rate_observation/v_rate_benchmark
  -- compute -- recomputed here because neither exposes the per-vendor join
  -- key this scorecard needs alongside it.
  select item_family_id, unit_normalized, event_id,
         percentile_cont(0.5) within group (order by net_rate) as median_rate
  from comparable_obs
  group by item_family_id, unit_normalized, event_id
),
price_position as (
  select
    co.vendor_id,
    co.event_id,
    avg(co.net_rate / pm.median_rate) as avg_price_ratio,
    count(*) as priced_observation_count
  from comparable_obs co
  join price_medians pm
    on pm.item_family_id = co.item_family_id
   and pm.unit_normalized is not distinct from co.unit_normalized
   and pm.event_id is not distinct from co.event_id
  where pm.median_rate > 0
  group by co.vendor_id, co.event_id
),
discount_given as (
  select
    rr.vendor_id,
    e.event_id,
    avg(rr.discount_pct) as avg_discount_pct,
    count(rr.discount_pct) as discount_observation_count
  from public.rate_reference rr
  left join public.entries e on e.id = rr.entry_id
  where rr.discount_pct is not null
  group by rr.vendor_id, e.event_id
),
vendor_flags_all as (
  -- See header: same vendor-attribution rule as v_vendor_concentration's
  -- vendor_flags CTE (flags.vendor_id set directly), across every status.
  select
    f.vendor_id,
    fe.event_id,
    count(*) as flag_history_count,
    count(*) filter (where f.status = 'open') as open_flag_count,
    sum(f.amount_at_risk) filter (where f.status = 'open') as open_flag_amount_at_risk
  from public.flags f
  left join public.entries fe on fe.id = f.entry_id
  where f.vendor_id is not null
  group by f.vendor_id, fe.event_id
),
gstin_exceptions as (
  -- FIX (integration review): vendor_gstin_invalid_checksum and
  -- vendor_gstin_is_own_org are raised with only document_extraction_id set
  -- -- reconciliation_exception.entry_id is NULL on both (confirmed against
  -- lib/jobs/handlers/extract.ts, same finding 20260903000008's header
  -- documents for its own v_tax_credit_exposure). A direct join on
  -- re.entry_id therefore matched zero rows and this CTE always returned no
  -- exception for every vendor. Resolved the same way
  -- v_instrument_type_mix/v_tax_credit_exposure do: document_extraction ->
  -- source_document -> entries, entry_id from coalesce(de.entry_id, sd.entry_id).
  select
    e.vendor_id,
    e.event_id,
    bool_or(re.status = 'open') as has_open_gstin_exception
  from public.reconciliation_exception re
  join public.document_extraction de on de.id = re.document_extraction_id
  left join public.source_document sd on sd.id = de.source_document_id
  join public.entries e on e.id = coalesce(de.entry_id, sd.entry_id)
  where re.exception_type in ('vendor_gstin_invalid_checksum', 'vendor_gstin_is_own_org')
    and e.vendor_id is not null
  group by e.vendor_id, e.event_id
)
select
  b.vendor_id,
  b.display_name,
  b.normalized_name,
  b.is_confirmed,
  b.event_id,
  b.entry_count,
  b.total_amount,
  b.first_entry_date,
  b.last_entry_date,
  b.entries_with_documents,
  b.document_coverage_pct,
  vc.pct_of_total_spend,
  v.gstin,
  case
    when v.gstin is null then 'missing'
    when coalesce(ge.has_open_gstin_exception, false) then 'flagged'
    else 'valid'
  end as gstin_status,
  round(pp.avg_price_ratio::numeric, 3) as avg_price_ratio,
  coalesce(pp.priced_observation_count, 0) as priced_observation_count,
  round(dg.avg_discount_pct, 2) as avg_discount_pct,
  coalesce(dg.discount_observation_count, 0) as discount_observation_count,
  coalesce(vf.flag_history_count, 0) as flag_history_count,
  coalesce(vf.open_flag_count, 0) as open_flag_count,
  vf.open_flag_amount_at_risk
from base b
join public.vendor v on v.id = b.vendor_id
left join public.v_vendor_concentration vc
  on vc.vendor_id = b.vendor_id and vc.event_id is not distinct from b.event_id
left join price_position pp
  on pp.vendor_id = b.vendor_id and pp.event_id is not distinct from b.event_id
left join discount_given dg
  on dg.vendor_id = b.vendor_id and dg.event_id is not distinct from b.event_id
left join vendor_flags_all vf
  on vf.vendor_id = b.vendor_id and vf.event_id is not distinct from b.event_id
left join gstin_exceptions ge
  on ge.vendor_id = b.vendor_id and ge.event_id is not distinct from b.event_id;

-- ----------------------------------------------------------------------------
-- v_vendor_activity_span -- B-09
-- ----------------------------------------------------------------------------
create view public.v_vendor_activity_span with (security_invoker = true) as
with vendor_entries as (
  select e.vendor_id, e.event_id, e.date, e.amount
  from public.entries e
  where e.is_void = false and e.vendor_id is not null and e.date is not null
),
vendor_days as (
  select distinct vendor_id, event_id, date
  from vendor_entries
),
day_gaps as (
  select
    vendor_id,
    event_id,
    date,
    date - lag(date) over (partition by vendor_id, event_id order by date) as gap_days
  from vendor_days
),
day_agg as (
  select
    vendor_id,
    event_id,
    min(date) as first_entry_date,
    max(date) as last_entry_date,
    count(*) as distinct_active_days,
    array_agg(date order by date) as active_dates
  from vendor_days
  group by vendor_id, event_id
),
gap_agg as (
  select vendor_id, event_id, max(gap_days) as max_gap_days
  from day_gaps
  group by vendor_id, event_id
),
entry_agg as (
  select
    vendor_id,
    event_id,
    count(*) as entry_count,
    sum(amount) as total_spend,
    max(amount) as max_single_amount
  from vendor_entries
  group by vendor_id, event_id
)
select
  da.vendor_id,
  v.display_name,
  v.normalized_name,
  da.event_id,
  da.first_entry_date,
  da.last_entry_date,
  (da.last_entry_date - da.first_entry_date) as active_span_days,
  ea.entry_count,
  da.distinct_active_days,
  coalesce(ga.max_gap_days, 0) as max_gap_days,
  ea.total_spend,
  ea.max_single_amount,
  (ea.entry_count = 1) as single_appearance,
  da.active_dates
from day_agg da
join entry_agg ea
  on ea.vendor_id = da.vendor_id and ea.event_id is not distinct from da.event_id
left join gap_agg ga
  on ga.vendor_id = da.vendor_id and ga.event_id is not distinct from da.event_id
join public.vendor v on v.id = da.vendor_id;

-- Brand-new objects -- a plain grant is all that's needed (no drop-and-recreate,
-- so nothing to re-grant on any OTHER view here).
grant select on
  public.v_vendor_scorecard,
  public.v_vendor_activity_span
to authenticated;
