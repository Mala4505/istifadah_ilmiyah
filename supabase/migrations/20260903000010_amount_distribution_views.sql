-- reporting-blueprint.md §8 Phase Six: "Forensics (D-05 … D-08) …". This file
-- carries the two pure amount-distribution tests, D-07 and D-08. Neither needs
-- any data the ledger does not already hold -- both read entries.amount for
-- non-void entries and nothing else -- which is exactly why the blueprint
-- flags them as reports that "read as rigorous to any auditor or trustee"
-- with zero new inputs.
--
--   v_benford_leading_digit -- D-07 Benford's Law leading-digit test. One row
--     per leading digit 1..9 per event_id: the observed count of entry
--     amounts whose first significant digit is that digit, the event's window
--     total, and the observed / expected / deviation percentages. The
--     expected curve is Benford's own: P(d) = log10(1 + 1/d), i.e. digit 1
--     ~30.1% down to digit 9 ~4.6%. All nine digit rows are emitted for every
--     event even when a digit was never observed (observed_count = 0) so the
--     app-side chart and goodness-of-fit stat always see a dense 1..9 series.
--
--     Leading-digit rule: first significant digit of abs(amount). The sign is
--     stripped (a -4,200 credit note contributes digit 4, same as a +4,200
--     invoice -- the test is about the magnitude humans wrote, not its
--     direction). Amounts with abs(amount) < 1 (including 0 and null) are
--     EXCLUDED and do not count toward total_count: they have no first
--     significant digit in the 1..9 sense the test is defined over, and at
--     this organisation's rupee scale a sub-₹1 ledger amount is a rounding
--     artefact, not a real bill. This exclusion is documented here rather than
--     left implicit because it changes the denominator every percentage is
--     taken against.
--
--     The goodness-of-fit statistic (MAD -- mean absolute deviation -- with
--     Nigrini's conformity bands) is deliberately NOT computed here: it is a
--     single scalar per event, trivially derived from these nine rows in the
--     loader, and keeping it app-side means the bands can be tuned without a
--     migration. See lib/reports/surfaces/amount-forensics.ts.
--
--   v_round_number_bias -- D-08 round-number bias. One row per
--     (department, vendor, event): how many of that pair's non-void entries
--     carry an amount that is a positive whole multiple of 1000
--     (amount > 0 and amount % 1000 = 0), and that as a share of the pair's
--     entry count. "A high share means estimates are being booked as
--     invoices" (blueprint). The view stays at (department, vendor) grain --
--     the loader rolls it up to department-level, vendor-level and an overall
--     figure, and applies a minimum-entry-count materiality bar so a vendor
--     with one ₹5,000 entry is not reported as "100% round". Rollup rows are
--     NOT emitted from the view itself: a UNION ALL of three grains in one
--     result set is harder for the loader to filter and sum correctly than
--     re-aggregating the base grain it already has.
--
--     department_id / vendor_id are exposed as their own columns (not just the
--     names) because every figure in the section links to the filtered entry
--     list -- /entries?department_id=<id> , /entries?vendor_id=<id> -- and a
--     name is neither unique nor URL-filterable (reporting-blueprint §6 fix
--     #4). Either id can be null (an entry with no department or no vendor
--     assigned); the name column is then null too and the section renders it
--     as an explicit "Unassigned" bucket rather than dropping the row.
--
-- entries.amount is numeric(14,2) and nullable. Both views require a non-null
-- amount (a row with no amount tells neither test anything) and is_void =
-- false, matching every other spend view in this codebase.
--
-- round() type note (this bit Phase 4 on push -- 20260903000002 header): the
-- trap is round(double precision, int), which does not exist. Neither view
-- hits it. v_benford_leading_digit's expected curve is log(numeric) -- a
-- single-argument log is Postgres base-10 log and returns numeric -- times
-- 100, still numeric; its observed percentage is
-- integer::numeric / nullif(integer, 0) * 100, numeric division, numeric
-- result. v_round_number_bias's share is the same integer::numeric / int
-- shape. No percentile_cont, avg, sqrt, power or float column reaches a
-- round() in this file, so every round(x, 2) here already has a numeric x.
--
-- RLS: entries is department-scoped (can_see_department); department and
-- vendor are staff-wide SELECT. Both views read entries directly (no LEFT
-- JOIN that could null an entry column), so a department-scoped reviewer sees
-- ONLY their own departments' entries in both tests -- their Benford curve and
-- their round-number shares are computed over the slice they can see, not the
-- whole corpus. For the trustee / SA who can see every department this is the
-- organisation-wide test the blueprint intends; for a single-department
-- reviewer it is legitimately narrower. This is the same visibility property
-- v_instrument_type_mix and the other entries-based views document.
--
-- security_invoker = true on both (every view in this codebase runs as the
-- calling user so base-table RLS applies). Each is a new object the broad
-- `grant select on all tables in schema public` (20260808000026) predates, so
-- each needs its own explicit grant. event_id is a plain output column on
-- both -- filtering happens at the query site, matching 20260822000011.

-- ----------------------------------------------------------------------------
-- v_benford_leading_digit -- D-07
-- ----------------------------------------------------------------------------
create view public.v_benford_leading_digit with (security_invoker = true) as
with observed as (
  select
    e.event_id,
    -- First significant digit of the magnitude: floor to a whole rupee,
    -- cast through bigint so the text form never carries a decimal point,
    -- then take the leading character. abs() strips the sign first.
    left((floor(abs(e.amount))::bigint)::text, 1)::int as leading_digit
  from public.entries e
  where e.is_void = false
    and e.amount is not null
    and abs(e.amount) >= 1
),
digit_counts as (
  select event_id, leading_digit, count(*) as observed_count
  from observed
  group by event_id, leading_digit
),
event_totals as (
  select event_id, count(*) as total_count
  from observed
  group by event_id
),
digit_grid as (
  select generate_series(1, 9) as leading_digit
),
per_digit as (
  select
    et.event_id,
    g.leading_digit,
    coalesce(dc.observed_count, 0) as observed_count,
    et.total_count,
    case
      when et.total_count > 0
      then coalesce(dc.observed_count, 0)::numeric / et.total_count * 100
      else 0::numeric
    end as observed_pct_raw,
    -- Benford: P(d) = log10(1 + 1/d). Single-argument log() is base-10 and
    -- returns numeric; 1.0 forces numeric (not integer) division.
    log(1 + 1.0 / g.leading_digit) * 100 as expected_pct_raw
  from event_totals et
  cross join digit_grid g
  left join digit_counts dc
    on dc.event_id is not distinct from et.event_id
   and dc.leading_digit = g.leading_digit
)
select
  event_id,
  leading_digit,
  observed_count,
  total_count,
  round(observed_pct_raw, 2) as observed_pct,
  round(expected_pct_raw, 2) as expected_pct,
  round(observed_pct_raw - expected_pct_raw, 2) as deviation_pct
from per_digit;

-- ----------------------------------------------------------------------------
-- v_round_number_bias -- D-08
-- ----------------------------------------------------------------------------
create view public.v_round_number_bias with (security_invoker = true) as
select
  e.department_id,
  d.name as department_name,
  e.vendor_id,
  v.display_name as vendor_display_name,
  e.event_id,
  count(*) as entry_count,
  count(*) filter (where e.amount > 0 and (e.amount % 1000) = 0) as round_count,
  round(
    count(*) filter (where e.amount > 0 and (e.amount % 1000) = 0)::numeric
      / nullif(count(*), 0) * 100,
    2
  ) as round_share_pct
from public.entries e
left join public.department d on d.id = e.department_id
left join public.vendor v on v.id = e.vendor_id
where e.is_void = false
  and e.amount is not null
group by e.department_id, d.name, e.vendor_id, v.display_name, e.event_id;

-- DROP VIEW loses grants; these are brand-new objects so a plain grant is all
-- that's needed (no drop-and-recreate here).
grant select on
  public.v_benford_leading_digit,
  public.v_round_number_bias
to authenticated;
