-- reporting-blueprint.md §8 Phase Four: "The money-finding reports: C-04, C-09,
-- B-01, D-01, D-02. The dashboard starts producing findings, not just
-- descriptions."
--
-- Four new views (B-01's concentration curve is pure app-side cumulation over
-- the existing v_vendor_concentration and needs nothing here):
--
--   v_rate_observation  -- C-04 above-median overpayment. One row per COMPARABLE
--     rate_reference observation, with the (item_family, unit, event) median
--     net_rate attached via a window-free medians CTE, plus a precomputed
--     overpayment_amount = max(0, net_rate - median) * quantity. The strip plot
--     needs every observation (one dot each); the headline number is the sum of
--     overpayment_amount. Deliberately distinct from v_rate_benchmark
--     (20260814000007), which is the grouped median/min/max -- this is the
--     per-observation grain that view aggregates away.
--
--   v_instrument_type_mix  -- C-09. Per (department, instrument_type, event):
--     entry count and summed entry amount, each non-void entry attributed to
--     exactly ONE instrument type via its "best" bill (distinct-on, preferring a
--     verified extraction that actually carries a type). Entries with an
--     extraction but no classified type bucket as 'unclassified'; entries with
--     no bill at all bucket as 'no_document' -- the two are different findings
--     ("we haven't typed it" vs "there is nothing to type") and must not merge.
--
--   v_exception_heatmap  -- D-01. Per (source_table, issue_type, severity,
--     department, event): OPEN issue count and summed amount_at_risk, unioning
--     reconciliation_exception + flags the same way v_open_issues does. Type
--     down / department across / shade by ₹ -- the matrix the blueprint's D-01
--     asks for. department_id/event_id are null for an entry-less issue
--     (vendor-level flag, batch-level exception), same documented limitation as
--     v_open_issues / v_compliance_summary -- the query site keeps those rows
--     via `.or(event_id.eq.X,event_id.is.null)`, never a plain `.eq`.
--
--   v_amount_at_risk_by_status  -- D-02 amount-at-risk waterfall. Per
--     (source_table, status, event): issue count and summed amount_at_risk
--     across ALL statuses (not just open -- unlike every other issue view here),
--     so the app can compose the "total spend -> flagged -> confirmed/upheld ->
--     recovered or dismissed" waterfall. flags.status is open/confirmed/
--     dismissed; reconciliation_exception.status is open/resolved/dismissed --
--     the app maps confirmed+resolved to "upheld" and dismissed to "cleared".
--
-- security_invoker = true on all four (every view in this codebase runs as the
-- calling user so base-table RLS applies). Each is a new object the broad
-- `grant select on all tables in schema public` (20260808000026) predates, so
-- each needs its own explicit grant. event_id is a plain output column on every
-- one -- filtering happens at the query site, matching 20260822000011.

-- ----------------------------------------------------------------------------
-- v_rate_observation -- C-04
-- ----------------------------------------------------------------------------
create view public.v_rate_observation with (security_invoker = true) as
with obs as (
  select
    rr.id as rate_reference_id,
    rr.item_family_id,
    fam.family_key,
    fam.label as family_label,
    rr.unit_normalized,
    rr.vendor_id,
    v.display_name as vendor_display_name,
    rr.net_rate,
    coalesce(rr.quantity, 1) as quantity,
    rr.observed_date,
    rr.entry_id,
    e.department_id,
    d.name as department_name,
    e.event_id
  from public.rate_reference rr
  join public.item_family fam on fam.id = rr.item_family_id
  left join public.vendor v on v.id = rr.vendor_id
  left join public.entries e on e.id = rr.entry_id
  left join public.department d on d.id = e.department_id
  where rr.is_comparable = true
    and rr.item_family_id is not null
    and rr.net_rate is not null
),
medians as (
  select
    item_family_id,
    unit_normalized,
    event_id,
    percentile_cont(0.5) within group (order by net_rate) as median_rate,
    count(*) as observation_count,
    count(distinct vendor_id) as vendor_count
  from obs
  group by item_family_id, unit_normalized, event_id
)
select
  o.rate_reference_id,
  o.item_family_id,
  o.family_key,
  o.family_label,
  o.unit_normalized,
  o.vendor_id,
  o.vendor_display_name,
  o.net_rate,
  o.quantity,
  o.observed_date,
  o.entry_id,
  o.department_id,
  o.department_name,
  o.event_id,
  m.median_rate,
  m.observation_count,
  m.vendor_count,
  case
    when m.median_rate is not null and o.net_rate > m.median_rate
    -- percentile_cont returns double precision, so the arithmetic below is
    -- double too; round(double, int) doesn't exist in Postgres (only
    -- round(numeric, int)) -- cast the product to numeric first.
    then round(((o.net_rate - m.median_rate) * o.quantity)::numeric, 2)
    else 0
  end as overpayment_amount
from obs o
join medians m
  on m.item_family_id = o.item_family_id
 and m.unit_normalized is not distinct from o.unit_normalized
 and m.event_id is not distinct from o.event_id;

-- ----------------------------------------------------------------------------
-- v_instrument_type_mix -- C-09
-- ----------------------------------------------------------------------------
create view public.v_instrument_type_mix with (security_invoker = true) as
with entry_instrument as (
  select distinct on (e.id)
    e.id as entry_id,
    e.department_id,
    e.event_id,
    e.amount,
    coalesce(de.instrument_type_verified, de.instrument_type_ocr) as instrument_type,
    (de.id is not null) as has_extraction
  from public.entries e
  left join public.source_document sd on sd.entry_id = e.id
  left join public.document_extraction de
    on de.source_document_id = sd.id
   and coalesce(de.entry_id, sd.entry_id) = e.id
  where e.is_void = false
  -- One row per entry: prefer a bill that carries a type, then a verified one,
  -- then the newest -- deterministic so the mix is stable between refreshes.
  order by
    e.id,
    (coalesce(de.instrument_type_verified, de.instrument_type_ocr) is null),
    (de.verified_at is null),
    de.id desc
)
select
  ei.department_id,
  d.name as department_name,
  ei.event_id,
  coalesce(
    ei.instrument_type,
    case when ei.has_extraction then 'unclassified' else 'no_document' end
  ) as instrument_type,
  count(*) as entry_count,
  coalesce(sum(ei.amount), 0) as total_amount
from entry_instrument ei
left join public.department d on d.id = ei.department_id
group by
  ei.department_id,
  d.name,
  ei.event_id,
  coalesce(
    ei.instrument_type,
    case when ei.has_extraction then 'unclassified' else 'no_document' end
  );

-- ----------------------------------------------------------------------------
-- v_exception_heatmap -- D-01
-- ----------------------------------------------------------------------------
create view public.v_exception_heatmap with (security_invoker = true) as
select
  combined.source_table,
  combined.issue_type,
  combined.severity,
  e.department_id,
  d.name as department_name,
  e.event_id,
  count(*) as issue_count,
  coalesce(sum(combined.amount_at_risk), 0) as amount_at_risk
from (
  select
    'reconciliation_exception'::text as source_table,
    re.entry_id,
    re.exception_type as issue_type,
    re.severity,
    re.amount_at_risk
  from public.reconciliation_exception re
  where re.status = 'open'
  union all
  select
    'flags'::text as source_table,
    f.entry_id,
    f.flag_type as issue_type,
    f.severity,
    f.amount_at_risk
  from public.flags f
  where f.status = 'open'
) combined
left join public.entries e on e.id = combined.entry_id
left join public.department d on d.id = e.department_id
group by combined.source_table, combined.issue_type, combined.severity, e.department_id, d.name, e.event_id;

-- ----------------------------------------------------------------------------
-- v_amount_at_risk_by_status -- D-02
-- ----------------------------------------------------------------------------
create view public.v_amount_at_risk_by_status with (security_invoker = true) as
select
  combined.source_table,
  combined.status,
  e.event_id,
  count(*) as issue_count,
  coalesce(sum(combined.amount_at_risk), 0) as amount_at_risk
from (
  select
    'reconciliation_exception'::text as source_table,
    re.entry_id,
    re.status,
    re.amount_at_risk
  from public.reconciliation_exception re
  union all
  select
    'flags'::text as source_table,
    f.entry_id,
    f.status,
    f.amount_at_risk
  from public.flags f
) combined
left join public.entries e on e.id = combined.entry_id
group by combined.source_table, combined.status, e.event_id;

-- DROP VIEW loses grants; these are brand-new objects so a plain grant is all
-- that's needed (no drop-and-recreate here).
grant select on
  public.v_rate_observation,
  public.v_instrument_type_mix,
  public.v_exception_heatmap,
  public.v_amount_at_risk_by_status
to authenticated;
