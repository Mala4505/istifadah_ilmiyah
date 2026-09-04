-- reporting-blueprint.md §4 C-10 -- "HSN coverage & GST anomaly. Which bills
-- carry an HSN or SAC code, and where the tax charged departs from the rate
-- that code implies."
--
-- Depends on hsn_gst_rate (20260903000018). Kept in a SEPARATE migration from
-- that input-table DDL so the table migration stays pure schema and this one
-- stays pure read-model -- they can be reasoned about, reverted, and re-run
-- independently.
--
--   v_hsn_gst_anomaly -- one row per document_extraction (a "bill") that has at
--     least one line item. Two independent questions per row:
--
--     (a) COVERAGE -- of this bill's line items, how many carry an HSN/SAC
--         code at all (lines_with_hsn / line_count). This half needs nothing
--         from hsn_gst_rate and works the day this ships.
--
--     (b) ANOMALY -- for the lines whose printed code matches a hsn_gst_rate
--         row (longest-prefix match: a 4-digit heading matches any 6/8-digit
--         code beneath it), the average expected rate is implied_gst_rate.
--         The rate actually charged on the bill is charged_gst_rate =
--         tax_amount / taxable_value * 100 (bill-level: there is NO per-line
--         tax_amount on document_extraction_line_item -- confirmed against
--         20260820000003, which collapsed the line-item money columns to
--         rate/discount/amount). is_anomaly is true only when BOTH rates are
--         known and they differ by more than GST_RATE_TOLERANCE_PCT
--         (lib/analytics/thresholds.ts = 0.15 percentage points; hardcoded
--         here because SQL cannot import the TS constant -- keep the two in
--         sync, and an analyst may widen the band as the code table matures).
--         With hsn_gst_rate empty, implied_gst_rate is null on every row and
--         is_anomaly is uniformly false -- the coverage columns still populate.
--
-- Line-item column names (grepped, not guessed): hsn_sac_code_ocr /
-- hsn_sac_code_verified, quantity_ocr/_verified, rate_ocr/_verified,
-- amount_ocr/_verified (20260808000022 as amended by 20260820000003 -- there
-- is no line_amount_* or net_rate_* any more). document_extraction carries
-- subtotal_*, tax_amount_*, total_amount_* (20260808000021); prefer _verified.
--
-- Entry -> bill chain: document_extraction.source_document_id is NOT NULL and
-- UNIQUE (1:1 with source_document), and the entry is
-- coalesce(de.entry_id, sd.entry_id) -- same resolution every Phase 3-5 view
-- uses. No distinct-on needed: the grain here IS the bill, so an entry with
-- two bills correctly yields two rows.
--
-- Department-leak note (same property as v_rate_observation / v_purchase_tree):
-- document_extraction and document_extraction_line_item are staff-wide;
-- `entries` is department-scoped by RLS (private.can_see_department,
-- 20260808000026). A department-scoped reviewer querying this view sees every
-- bill row, but entry_id, vendor_id, vendor_display_name, department_id,
-- department_name and event_id read NULL for a bill whose entry sits outside
-- their department (the LEFT JOIN back to entries returns no row, not an
-- error). The coverage / implied-rate / charged-rate columns come only from
-- the bill itself and are always populated.
--
-- percentile_cont / avg / division all appear below -> every derived figure is
-- cast ::numeric before round() (Postgres has no round(double precision, int)).
--
-- security_invoker = true (every view here runs as the calling user so
-- base-table RLS applies). Brand-new object, not covered by 20260808000026's
-- blanket grant or any later one -- explicit grant below. event_id is a plain
-- output column; the query site filters it (20260822000011 convention).
-- ---------------------------------------------------------------------------

create view public.v_hsn_gst_anomaly with (security_invoker = true) as
with line_norm as (
  select
    li.document_extraction_id,
    -- strip everything but digits; '' -> null so "no code" is unambiguous
    nullif(regexp_replace(coalesce(li.hsn_sac_code_verified, li.hsn_sac_code_ocr), '\D', '', 'g'), '') as hsn_digits
  from public.document_extraction_line_item li
),
line_rate as (
  select
    ln.document_extraction_id,
    ln.hsn_digits,
    m.implied_rate
  from line_norm ln
  left join lateral (
    select hgr.gst_rate as implied_rate
    from public.hsn_gst_rate hgr
    where ln.hsn_digits is not null
      and left(ln.hsn_digits, length(hgr.code)) = hgr.code
    order by length(hgr.code) desc   -- most specific code wins
    limit 1
  ) m on true
),
line_agg as (
  select
    document_extraction_id,
    count(*)                         as line_count,
    count(hsn_digits)                as lines_with_hsn,
    count(implied_rate)              as lines_matched,
    avg(implied_rate)::numeric       as implied_rate_avg
  from line_rate
  group by document_extraction_id
),
bill as (
  select
    de.id                                              as bill_id,
    coalesce(de.entry_id, sd.entry_id)                 as entry_id,
    la.line_count,
    la.lines_with_hsn,
    la.lines_matched,
    round((la.lines_with_hsn::numeric / nullif(la.line_count, 0)) * 100, 2) as hsn_coverage_pct,
    round(coalesce(de.subtotal_verified, de.subtotal_ocr)::numeric, 2)      as taxable_value,
    round(coalesce(de.tax_amount_verified, de.tax_amount_ocr)::numeric, 2)  as tax_amount,
    round(coalesce(de.total_amount_verified, de.total_amount_ocr)::numeric, 2) as bill_total,
    case when la.lines_matched > 0 then round(la.implied_rate_avg, 2) else null end as implied_gst_rate,
    case
      when coalesce(de.subtotal_verified, de.subtotal_ocr) is not null
       and coalesce(de.subtotal_verified, de.subtotal_ocr) <> 0
       and coalesce(de.tax_amount_verified, de.tax_amount_ocr) is not null
      then round((coalesce(de.tax_amount_verified, de.tax_amount_ocr)
                  / coalesce(de.subtotal_verified, de.subtotal_ocr) * 100)::numeric, 2)
      else null
    end                                                as charged_gst_rate
  from line_agg la
  join public.document_extraction de on de.id = la.document_extraction_id
  join public.source_document sd on sd.id = de.source_document_id
)
select
  b.bill_id,
  b.entry_id,
  e.vendor_id,
  v.display_name                                       as vendor_display_name,
  e.department_id,
  d.name                                               as department_name,
  b.line_count,
  b.lines_with_hsn,
  b.lines_matched,
  b.hsn_coverage_pct,
  b.taxable_value,
  b.tax_amount,
  -- rupee weight for the coverage KPI: the bill's own total, else the ledger entry
  coalesce(b.bill_total, e.amount)                     as billed_amount,
  b.implied_gst_rate,
  b.charged_gst_rate,
  case
    when b.implied_gst_rate is not null and b.charged_gst_rate is not null
    then round((b.charged_gst_rate - b.implied_gst_rate)::numeric, 2)
    else null
  end                                                  as rate_gap_pp,
  (
    b.implied_gst_rate is not null
    and b.charged_gst_rate is not null
    and abs(b.charged_gst_rate - b.implied_gst_rate) > 0.15   -- GST_RATE_TOLERANCE_PCT
  )                                                    as is_anomaly,
  e.event_id
from bill b
left join public.entries e on e.id = b.entry_id
left join public.vendor v on v.id = e.vendor_id
left join public.department d on d.id = e.department_id;

grant select on public.v_hsn_gst_anomaly to authenticated;
