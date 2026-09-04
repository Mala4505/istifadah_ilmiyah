-- reporting-blueprint.md §8 Phase Six, cluster 7: A-11 (spend curve & peak
-- weeks, Budget & Spend surface) and D-03 (open item ageing, Integrity
-- surface). Two new views.
--
-- ---------------------------------------------------------------------------
--   v_weekly_spend_curve -- A-11. One row per (event_id, ISO week) across the
--     event's span. `week_start` is date_trunc('week', entries.date) (Monday,
--     Postgres ISO week). `entry_count` / `total_amount` are that week's
--     non-void spend (is_void = false; entries.amount is nullable so the sum
--     is coalesced to 0). The four window helpers are the same value repeated
--     on every row of an event so the app can read them off row[0] without a
--     second query:
--       event_week_count   -- number of weeks in the plotted span
--       peak_week_start    -- week_start of the single highest-spend week
--       peak_week_amount   -- that week's total_amount
--       mean_weekly_amount -- avg of the weekly totals (round(...::numeric,2))
--
--     ZERO-WEEK GAP-FILL: YES. The weekly grain is gap-filled with
--     generate_series so a week inside the event span with no spend still
--     produces a row (total_amount = 0). Rationale: A-11 feeds a per-week bar
--     axis ("when does the pressure land, when to staff next year") -- a
--     contiguous week axis with visible zero weeks tells that story better
--     than a sparse list that hides the quiet stretches. The span runs from
--     the earlier of (first spend week, event.starts_on week) to the later of
--     (last spend week, event.ends_on week), mirroring
--     lib/reports/hero-metrics.ts computeSpendTrend's "event dates first,
--     entries min/max as fallback" choice. It is capped at 520 weeks past the
--     span start as a guard against an implausible event date.
--     CONSEQUENCE: mean_weekly_amount is the mean over ALL span weeks
--     including the gap-filled zeros, so it reads as "average spend per week
--     of the event", not "average of the weeks that had activity" -- the
--     denominator is event_week_count. This is the figure most worth a
--     human's second look and is called out in the section KPI.
--
--     An event with no non-void dated entries produces no rows (the section
--     renders its empty state). Entries with a null date or null event_id are
--     excluded (no week / no event to place them in).
--
--   v_open_item_ageing -- D-03. One row per OPEN item, unioning
--     reconciliation_exception (status = 'open') and flags (status = 'open')
--     the SAME way the current v_open_issues does (20260822000010, the latest
--     create-or-replace -- it added a 4th event-resolution fallback,
--     source_document_id, over the original 3-way coalesce). Columns:
--       source_table  -- 'reconciliation_exception' | 'flags'
--       id            -- the row id IN THAT source table (not globally unique
--                        across the union -- key rows on source_table+id)
--       issue_type    -- exception_type / flag_type verbatim
--       severity      -- 'low' | 'medium' | 'high'
--       amount_at_risk-- numeric(14,2), nullable (many exception types set it)
--       entry_id      -- nullable: reconciliation_exception.entry_id is NULL
--                        for the document-/batch-level types (GSTIN checksum,
--                        duplicate_document_hash, page_count_*, ...); flags
--                        with entry_id null are the vendor-level ones. Those
--                        rows still appear here -- they are the queue too.
--       department_id / department_name -- resolved STRICTLY via the entry
--                        (entries.department_id). NULL ("Unassigned" in the
--                        UI) whenever entry_id is null or the entry has no
--                        department. Deliberately not resolved via vendor or
--                        document -- an exception with no entry has no
--                        department to sit in.
--       created_at    -- when the item was raised
--       days_open     -- extract(day from now() - created_at)::int, same
--                        formula as v_hub_status_ageing.days_in_status
--       age_bucket    -- '0-7' | '8-30' | '31-60' | '60+' (NOTE: a different
--                        set of cut points from v_hub_status_ageing's
--                        '0-2'/'3-7'/'8+' -- open findings age on a slower
--                        clock than the workflow pipeline)
--       event_id      -- reconciliation_exception: coalesce(entry, extraction
--                        -> source_document, import_batch, source_document
--                        direct) event_id. flags: entry event_id only (flags
--                        has no extraction / batch / document link to fall
--                        back through). NULL for an entry-less item whose
--                        parents carry no event -- the query site keeps those
--                        rows with `.or(event_id.eq.X,event_id.is.null)`, the
--                        Phase 0 §0.2 rule, NEVER a plain `.eq`.
--
-- RLS: both views are security_invoker = true (every view in this codebase
-- runs as the calling user, so base-table RLS applies). `entries` is
-- department-scoped (can_see_department); a department-scoped reviewer sees
-- null entry-derived columns (department_id, and the event_id branch that
-- resolves through the entry) for out-of-scope rows rather than an error, and
-- v_weekly_spend_curve shows only that reviewer's visible slice of weekly
-- spend. reconciliation_exception / flags / event / department / import_batch
-- / source_document / document_extraction are staff-wide.
--
-- Each view is a new object the broad `grant select on all tables in schema
-- public` (20260808000026) predates, so each needs its own explicit grant.
-- event_id is a plain output column on both -- filtering happens at the query
-- site, matching every Phase 2-5 view.

-- ----------------------------------------------------------------------------
-- v_weekly_spend_curve -- A-11
-- ----------------------------------------------------------------------------
create view public.v_weekly_spend_curve with (security_invoker = true) as
with weekly as (
  select
    e.event_id,
    date_trunc('week', e.date::timestamp)::date as week_start,
    count(*) as entry_count,
    coalesce(sum(e.amount), 0)::numeric as total_amount
  from public.entries e
  where e.is_void = false
    and e.date is not null
    and e.event_id is not null
  group by e.event_id, date_trunc('week', e.date::timestamp)::date
),
bounds as (
  select
    w.event_id,
    -- least/greatest skip NULLs in Postgres, so a missing event.starts_on /
    -- ends_on falls back to the entries' own first / last spend week.
    least(min(w.week_start), min(date_trunc('week', ev.starts_on::timestamp)::date)) as span_start,
    greatest(max(w.week_start), max(date_trunc('week', ev.ends_on::timestamp)::date)) as span_end
  from weekly w
  left join public.event ev on ev.id = w.event_id
  group by w.event_id
),
weeks as (
  select
    b.event_id,
    gs::date as week_start
  from bounds b
  cross join lateral generate_series(
    b.span_start::timestamp,
    least(b.span_end, b.span_start + interval '520 weeks')::timestamp,
    interval '1 week'
  ) as gs
),
filled as (
  select
    wk.event_id,
    wk.week_start,
    coalesce(w.entry_count, 0) as entry_count,
    coalesce(w.total_amount, 0)::numeric as total_amount
  from weeks wk
  left join weekly w on w.event_id = wk.event_id and w.week_start = wk.week_start
)
select
  f.event_id,
  f.week_start,
  f.entry_count,
  f.total_amount,
  count(*) over (partition by f.event_id) as event_week_count,
  first_value(f.week_start) over (
    partition by f.event_id order by f.total_amount desc, f.week_start
  ) as peak_week_start,
  max(f.total_amount) over (partition by f.event_id) as peak_week_amount,
  round(avg(f.total_amount) over (partition by f.event_id)::numeric, 2) as mean_weekly_amount
from filled f
order by f.event_id, f.week_start;

-- ----------------------------------------------------------------------------
-- v_open_item_ageing -- D-03
-- ----------------------------------------------------------------------------
create view public.v_open_item_ageing with (security_invoker = true) as
with combined as (
  select
    'reconciliation_exception'::text as source_table,
    re.id,
    re.entry_id,
    re.exception_type as issue_type,
    re.severity,
    re.amount_at_risk,
    re.created_at,
    re_e.department_id,
    coalesce(re_e.event_id, re_sd.event_id, re_ib.event_id, re_sd_direct.event_id) as event_id
  from public.reconciliation_exception re
  left join public.entries re_e on re_e.id = re.entry_id
  left join public.document_extraction re_de on re_de.id = re.document_extraction_id
  left join public.source_document re_sd on re_sd.id = re_de.source_document_id
  left join public.import_batch re_ib on re_ib.id = re.import_batch_id
  left join public.source_document re_sd_direct on re_sd_direct.id = re.source_document_id
  where re.status = 'open'
  union all
  select
    'flags'::text as source_table,
    f.id,
    f.entry_id,
    f.flag_type as issue_type,
    f.severity,
    f.amount_at_risk,
    f.created_at,
    f_e.department_id,
    f_e.event_id
  from public.flags f
  left join public.entries f_e on f_e.id = f.entry_id
  where f.status = 'open'
)
select
  c.source_table,
  c.id,
  c.issue_type,
  c.severity,
  c.amount_at_risk,
  c.entry_id,
  c.department_id,
  d.name as department_name,
  c.created_at,
  extract(day from now() - c.created_at)::int as days_open,
  case
    when extract(day from now() - c.created_at) <= 7 then '0-7'
    when extract(day from now() - c.created_at) <= 30 then '8-30'
    when extract(day from now() - c.created_at) <= 60 then '31-60'
    else '60+'
  end as age_bucket,
  c.event_id
from combined c
left join public.department d on d.id = c.department_id;

grant select on
  public.v_weekly_spend_curve,
  public.v_open_item_ageing
to authenticated;
